// STATE → DRAW LIST for the single-canvas mirror stage.
//
// One walk over the paint order (`paintOrder.ts`) that composes what the DOM backend composes — global transform,
// cascaded opacity, cascaded tint, hidden-ness, clip scopes — and, at each node, asks `paintSpec.ts` for the
// commands that paint it. It produces three things:
//
//   * the DRAW LIST itself (caller-owned; this module pushes into it and never creates one),
//   * the OVERLAY RECORDS — the nodes a flat quad list cannot paint (text, WebGL shader surfaces, particle
//     systems, Spine clips, card trails), handed to the Wave-2 DOM overlay. M2's `fxSource` gives the two gsw
//     RUNTIME kinds a quad as well: the surface a runtime painted, uploaded as a texture and drawn at the node's
//     own paint index. The classification does not move — the node is still an overlay node, it just also has
//     pixels in the list — so the union oracle the offline gate asserts is untouched.
//   * the HIT ENTRIES — the input surfaces, built during THIS walk rather than a second one, so the two can never
//     describe different geometry (`hitTest.ts`).
//
// COMPOSITION IS THE ORACLE'S. Every rule here is the one `scripts/lib/mirror-probe.mjs`'s `walkResolved`
// reproduces offline, which in turn cites `mirrorRenderer`'s own `visit`:
//   * GLOBAL   — a node with no `transform` inherits its parent's global; a streamed matrix composes onto it.
//   * HIDDEN   — this node or any ancestor `visible:false`, plus the ORPHAN hold (a node naming a parent the map
//                does not hold; drawing it at the stage root would collapse it onto the design origin).
//   * OPACITY  — `modAlpha = modulate?.a ?? opacity`, `selfAlpha = selfModulate?.a ?? 1`. The `modulate.a` half
//                CASCADES to children, the self-modulate half applies to the node's OWN paint only.
//   * TINT     — the same split on RGB: `childTint = parentTint × modulate.rgb`, `ownTint = childTint ×
//                self_modulate.rgb` (`mirrorRenderer`'s `childTint` / `ownTint`). Premultiplied into the quad.
// The offline gate (`scripts/verify-canvas-drawlist.mjs`) asserts the two agree node for node on every recording.
//
// THE OVERRIDE CHANNELS. Four inputs let a caller substitute what a node is DRAWN at without touching the wire
// state it was streamed with — the canvas equivalent of the DOM backend writing a style onto an element:
//   * `transformOverrides` — an ABSOLUTE rendered global (a tween/flight sample, and M1a's spread placement).
//   * `alphaOverrides`     — an animated `modulate.a` / `self_modulate.a`, on the same cascade/own-paint split.
//   * `cosmeticOffsets`    — a design-space translate INHERITED by the subtree (the held-card lift, eager scroll).
//   * `captureGlobals`     — the read-back half: what the walk actually baked, for a named handful of nodes.
// `mGame` — the true 1920-space pose a tap is answered with — is deliberately blind to all four.
//
// THE WIDE-SCREEN SPREAD (M1a) is computed HERE, in this walk, by `@/mirror/spreadLayout` — the same pure module
// the DOM walk calls. It is not an override channel: a node's shift is a function of the context its ancestors
// handed it, so it has to be threaded down the walk that is already threading everything else. `SpreadCtx` rides
// beside the transform chain; the node's own absolute `dx` is added to its DRAWN origin (`gSpread`) and to nothing
// else, so `gGame` — what a tap sends — stays true 1920-space at every viewport. At `spreadFactor === 1` the whole
// thing short-circuits to a frozen root context and never allocates.
//
// THE VIEW SCALE (M2) rides the same way, through `@/mirror/viewScaleLayout` — again the module the DOM walk uses.
// The DOM applies a stamp by PREPENDING a design-space matrix onto the item's element and letting CSS nesting
// cascade it, so a descendant renders at `V_ancestors · mDesign_N · gStretched_child`: the accumulated stamp
// product LEFT-multiplies the child's own spread-shifted global. A flat list has no nesting, so `vsIn` — that
// product — is threaded down the walk and `gScaled = vsSelf · gSpread` at each node.
//
//   FOLDING THE STAMP INTO `gRaw` INSTEAD WOULD BE WRONG. `gRaw` is what children compose against, and a child's
//   own spread shift `dx` is added AFTER that composition — so folding would leave the child's `dx` UNSCALED
//   while the DOM scales it, an error of `(k−1)·dx` that is exactly 0 at 16:9 and up to ~60 px on the shop's
//   2520-wide stage. `canvasViewScale.spec`'s S9 is that property.
//
// `gGame` is never touched (taps stay true), `gRaw` is never touched (the cascade is the stamp product's job),
// and `capturedGlobals` keeps banking the PRE-scale `gSpread` — the DOM twin writes `el.style.transform` straight
// to the element, bypassing its style cache, so the placement it retains is pre-scale too.
//
// WHAT IS NOT HERE YET, and where it lands:
//   * INCREMENTAL PATCHING. This is a FULL rebuild, every time. The three-tier plan slots in as follows, and the
//     seams for all three already exist:
//       tier 1 — STRUCTURAL (a new `state.orderedIds` reference, or a keyframe): rebuild everything. Today's path;
//                `PaintOrderCache` already detects the signal and drops its sibling sorts on it.
//       tier 2 — SUBTREE (a changed node's paint/clip/box): re-emit the commands inside that node's
//                `[spanStart, spanEnd)` interval. The interval is exactly why `paintOrder` computes spans and
//                asserts they are contiguous — a subtree is one splice, not a scatter.
//       tier 3 — NUMERIC (a transform or a `modulate:a` tween, which probe P8 measured as the dominant hint kind):
//                overwrite the affected commands' floats in place, with no re-walk at all. That needs a per-node
//                command RANGE, which is what `NodeCommandRange` below records.
//
// Self-contained per the mirror decoupling rule, and — like `paintSpec` — carrying NO RUNTIME dependency on
// `@godot-scene-web/canvas`: the list is injected, so this module runs unchanged under bare Node in the gate.

import type { DrawList } from "@godot-scene-web/canvas";

import { IDENTITY_AFFINE, affineMul, type Affine } from "@/mirror/affine";
import { CLIP_AXIS_CANDIDATE_NAMES, resolveClipAxisOutset } from "@/mirror/clipAxis";
import { clipAxisOn } from "@/mirror/nodeStyles";
import { isMapStrokeNode } from "@/mirror/renderer/sharedFlightPolicy";
import { REMOTE_FOLLOWER_TYPES, isCombatPileContainer } from "@/mirror/renderer/interactionPolicy";
import { spreadSceneIdentityEnv } from "@/mirror/renderer/staticBackgroundPolicy";
import {
  MIRROR_DESIGN_HEIGHT,
  MIRROR_DESIGN_WIDTH,
  nodeTypeLeaf,
  type MirrorColor,
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";
import {
  computeViewScaleStamp,
  designAabbOf,
  opensCardRewardScreen,
  resolveViewScaleForNode,
  viewScaleNominalBox,
  viewScaleStampMatrix,
  type ViewScaleEnv,
  type ViewScaleStampIndex
} from "@/mirror/viewScaleLayout";
import { computeTipScaleStamp, type TipScaleEnv } from "@/mirror/tipScaleLayout";
import type { TipAabb } from "@/mirror/hoverTipScaleMath";
import { TOOLTIP_TYPE } from "@/mirror/raise/constants";
import { auditSpreadClaim, resetSpreadAudit, type SpreadAudit } from "@/mirror/canvas/spreadAudit";
import {
  applyDrawnFieldRebase,
  computeSpread,
  createSpreadOut,
  fieldDxAtOriginX,
  rootSpreadCtx,
  spreadDrawBox,
  childParentWidth as spreadChildParentWidth,
  type SpreadAffine,
  type SpreadCtx,
  type SpreadEnv,
  type SpreadOut
} from "@/mirror/spreadLayout";

import {
  NO_CLIP_SCOPES,
  buildHitEntry,
  isHitSurfaceCandidate,
  resolveSceneInfo,
  type ClipScope,
  type HitEntry,
  type HitMemo
} from "@/mirror/canvas/hitTest";
import { buildPaintOrder, paintOrderAssertsOn, type PaintOrder, type PaintOrderCache } from "@/mirror/canvas/paintOrder";
import {
  FX_QUAD_KINDS,
  classifyNode,
  createPaintScratch,
  emitFxQuad,
  emitNodePaint,
  emitSpineQuad,
  emitTextGlyphs,
  emitTextQuad,
  emitTrailQuads,
  nodeClipSpec,
  overlayRecordFor,
  placedBoxAabbInto,
  type FxQuadSource,
  type GlyphFloorProbe,
  type NodeClass,
  type NodePaintInput,
  type OverlayKind,
  type OverlayRecord,
  type PaintScratch,
  type PaintSink,
  type SpineQuadBox,
  type TextGlyphSource,
  type TextQuadSource,
  type TextSnap,
  type TrailQuadSource
} from "@/mirror/canvas/paintSpec";

/**
 * Where one node's OWN PAINT landed in the list — the handle tier-3 numeric patching will overwrite through.
 *
 * Strictly the node's own commands: not its clip push (that is {@link ClipCommandRange}) and not its children's,
 * which is what makes the range splice-able on its own. A node that painted nothing has no entry.
 */
export interface NodeCommandRange {
  /** First command index the node's own paint contributed. */
  start: number;
  /** One past the last. */
  paintEnd: number;
}

export interface DrawListStats {
  /** Live nodes in the state, and the ones the paint order actually reached. */
  nodes: number;
  ordered: number;
  /** Node classification (see `paintSpec`): `canvas ∪ overlay` is the visible painting set. */
  canvas: number;
  overlay: number;
  skip: number;
  /**
   * `canvas` nodes that pushed NO command — and a faithful result, not a hole.
   *
   * The painting predicate's broadest leg is `node.shaderId != null` (`nodeStyles.nodePaintsContent`): a node with a
   * material counts as painting whatever else it carries. A handful per screen — the top bar's HSV-tinted deck
   * button, a `wind_sway` node with a 0x0 box — carry a shader and NOTHING to apply it to (no texture, no fill).
   * The DOM backend paints nothing for them either: an interior node's shader `filter` rides its SELF layer
   * (`splitSelfStyle`), which has no background to filter. They stay classified `canvas` so the painting set keeps
   * matching the oracle exactly; this counter is how that shows up as a number rather than as a silent gap.
   */
  silent: number;
  overlayByKind: Record<OverlayKind, number>;
  /**
   * EFFECT QUADS pushed this build — shader/particle surfaces drawn from `fxSurfaces` at their own paint index.
   *
   * Always 0 without a {@link BuildDrawListOptions.fxSource}. It is deliberately
   * NOT a subtraction from `overlayByKind`: an fx node is still an overlay node — it still has a host element
   * carrying gsw's attributes, and the union oracle the offline gate asserts is unchanged. This counts the
   * PIXELS that reached the list, which is the difference between "the surface is wired" and "the surface draws".
   */
  fxQuads: number;
  /**
   * SPINE STILLS pushed as quads this build (M3 A2). Always 0 without
   * {@link BuildDrawListOptions.spineBoxes}; the offline gate and most unit builds pass no source at all.
   *
   * SELECTIVE by design, so this is deliberately far below `overlayByKind.spine`: a still is quadded only when
   * the cover pass says the game paints OVER it, which is the one case a hoisted `<img>` gets wrong. A creature
   * nothing overlaps keeps the element, keeps `spineClip`'s bytes-only still (no decoded RGBA on the GPU at all)
   * and looks identical either way.
   */
  spineQuads: number;
  /**
   * CARD-TRAIL QUADS pushed this build (M3 A4) — the cells of every live comet's ribbon, at the trail node's own
   * paint index. Always 0 without a {@link BuildDrawListOptions.trailSource}, and 0 on a screen with nothing
   * flying (a trail exists only while a card is moving).
   *
   * Counted rather than derived from `overlayByKind.trail`, and the two are unrelated numbers: a trail node is an
   * overlay node whether or not it has a live point history, and one stroke contributes up to 141 quads.
   */
  trailQuads: number;
  /**
   * TEXT QUADS pushed this build (M4). 0 without a `textSource`, and 0 for every label the path refused, paced or
   * could not raster — so this against `overlayCounts.text` is how many of a screen's labels the canvas owns.
   */
  textQuads: number;
  /**
   * LABELS drawn as OUTLINE GLYPH RUNS this build, and the runs they produced.
   *
   * 0 without a `glyphSource` — the offline gate has none. Two numbers rather than
   * one because they answer different questions: `textGlyphLabels` against `overlayByKind.text` is how much of a
   * screen the glyph path owns, while `textGlyphRuns` is what the executor will spend draw calls on — hb-gpu
   * carries the run's colour, matrix and SPREAD as UNIFORMS, so runs never merge and this IS the draw-call count.
   * One line costs one run per pass it appears in: shadow, outline and fill, so a shadowed outlined label is
   * three per line. A glyph label never also emits a quad; the two paths are exclusive per label.
   */
  textGlyphLabels: number;
  textGlyphRuns: number;
  /** Commands pushed, by kind. */
  commands: number;
  quads: number;
  ninePatches: number;
  polylines: number;
  glyphRuns: number;
  clips: number;
  maxClipDepth: number;
  /** Distinct texture handles referenced (the batch-key floor probe P4 measured). */
  textures: number;
  hitEntries: number;
}

/** One node's rendered placement, read back through {@link BuildDrawListOptions.captureGlobals}. */
export interface CapturedGlobal {
  /** The node's RENDERED global affine, BEFORE any cosmetic offset — i.e. what the walk baked. */
  g: Affine;
  /** The node's parent's rendered origin Y, so a parent-relative painted Y is `g[5] - parentTy`. */
  parentTy: number;
  /**
   * …and the pose it is ACTUALLY DRAWN AT: `g` with the inherited cosmetic offset and the view-scale product
   * folded in — the matrix the paint block uses. `g` cannot answer for it (it is deliberately pre-offset, because
   * its original consumers compose the NEXT offset against it), and the difference is exactly the readable-hand
   * lift, which is the term a landing measurement has to be able to subtract out rather than guess at.
   */
  drawn: Affine;
  /** Effective CanvasItem self-paint modulation, after cascaded modulate + self_modulate. */
  modulate: readonly [number, number, number, number];
}

/** A clip scope's command interval: the `clipPush` index and its matching `clipPop`. */
export interface ClipCommandRange {
  push: number;
  pop: number;
}

export interface DrawListBuild {
  order: PaintOrder;
  overlayRecords: OverlayRecord[];
  hitEntries: HitEntry[];
  /** Per-node command ranges, for the tier-3 patcher. Only nodes that pushed something appear. */
  ranges: Map<string, NodeCommandRange>;
  /** Composed own-paint inputs used by local canvas chrome updates. */
  nodePaintInputs: ReadonlyMap<string, NodePaintInput>;
  /**
   * Per-clipper command intervals. THE thing the contiguity invariant is checkable against: a clip scope is one
   * interval of the stream, so the executor can scissor across it and the patcher can splice inside it.
   */
  clipRanges: Map<string, ClipCommandRange>;
  /** Client-only hand control command, emitted in the combat-pile anchor's own paint range. */
  handRaiseChromeCommand: number;
  handRaiseAnchorId: string | null;
  /**
   * The nodes this build drew an EFFECT QUAD for (M2). Empty without a {@link BuildDrawListOptions.fxSource}.
   *
   * The overlay's input, and the reason it is a set rather than a count: a host whose surface is in the draw list
   * must stop compositing, while one without a quad must remain composited (unless covered) so an unavailable
   * surface cannot hide an effect.
   */
  fxQuadIds: ReadonlySet<string>;
  /**
   * Strict-stage semantic records that are explicitly proven to paint no
   * pixels (for example gsw's dormant transition binding). They occupy their
   * original overlay-stream position but intentionally emit no command.
   */
  stageOwnedNoopIds: ReadonlySet<string>;
  /**
   * The nodes this build drew a SPINE QUAD for (M3 A2). Empty without {@link BuildDrawListOptions.spineBoxes}.
   *
   * The overlay's input, and a set for the same reason `fxQuadIds` is: a creature the list painted must stop
   * compositing its `<img>`, and one it did NOT must keep it, or turning the flag on would lose a creature.
   */
  spineQuadIds: ReadonlySet<string>;
  /**
   * The nodes this build drew a TRAIL RIBBON for (M3 A4). Empty without a
   * {@link BuildDrawListOptions.trailSource}.
   *
   * The paint dump's input, not the overlay's: a trail record is DROPPED by the overlay on both settings (there
   * has never been an element for it), so nothing downstream has to stop compositing. What the set is for is
   * naming the commands — an untextured quad is otherwise indistinguishable from a solid fill, and the parity
   * comparer needs a `role` to account for these under their own pre-registered class.
   */
  trailQuadIds: ReadonlySet<string>;
  /**
   * The nodes this build drew a TEXT QUAD for (M4). Empty without a {@link BuildDrawListOptions.textSource}.
   *
   * The overlay's input, on `fxQuadIds`' rule rather than `trailQuadIds`': a label the list painted must stop
   * compositing its element, and one it did NOT — a refusal, a pacing, a face that has not loaded — must keep it,
   * or turning the flag on would blank a label. That is what makes every refusal on this path safe.
   */
  textQuadIds: ReadonlySet<string>;
  /**
   * The view-scale stamps this build applied, in paint order — a PURE PER-BUILD index (native's R8 rule: no
   * cross-build stamp memory, which is what caused the event-option snap-back three rounds running).
   *
   * Empty whenever the walk ran with no `viewScaleEnv` or with readability scaling disabled. `canvasRenderer` folds it into
   * the GAME-space input registry the pointer inverse consumes.
   */
  viewScaleStamps: ViewScaleStampIndex;
  /**
   * The paint order of the LAST stage-spanning opaque fill this build drew, or -1 when it drew none (R2).
   *
   * THE FACT AN OVERLAY NEEDS ABOUT DEPTH THAT IT CANNOT SEE. Every overlay element paints above the whole
   * canvas, so when the game opens a full-screen dialog — a deck view, a card grid, a shop sheet — the combat
   * screen's own labels keep painting OVER it. That is the second half of the user's U1 report, and it is not a
   * clip problem: nothing is out of bounds, something opaque was simply painted in front of it.
   *
   * The predicate is `mirrorRenderer.coverAbove`'s, restated HERE because the walk already has the composed
   * alpha and the drawn box: a `canvas`-class node with a `fill_color`, no shader, composed alpha at or above
   * `BACKSTOP_COVER_MIN_ALPHA`, an axis-aligned placement, and a box spanning the design stage to within
   * `COVER_EDGE_EPS`. Deliberately the LAST such fill rather than the first: a screen stacked over a screen
   * (a shop sheet over the map) is two backstops, and only the topmost one decides.
   *
   * It is a NUMBER on the build and changes nothing in the list — `overlay.ts` is what decides whether to act on
   * it, behind its own lever. Always computed, so the census can report it on either setting.
   */
  backstopOrder: number;
  /**
   * The COMPOSED ALPHA of that fill — `ownOpacity × fill_color.a`, clamped — or 0 when there is no backstop.
   *
   * `backstopOrder` alone can only answer "drop it or keep it", because a boolean threw this away. The number is
   * what lets a covered surface be DIMMED by exactly what the game dimmed it by: the deck view's sheets are
   * `#000000d9`, i.e. `a = 0.851`, and the DOM arm shows the labels under them at 14.9% — which is what the
   * player's reference actually looks like, and is not the same picture as "gone".
   */
  backstopAlpha: number;
  /** Is that fill BLACK? See {@link BACKSTOP_BLACK_EPS} — the only case CSS `opacity` can reproduce exactly. */
  backstopBlack: boolean;
  /**
   * The four matrices per LOCALLY-ANIMATED node the tier-3 transform patcher re-poses a subtree from (R7 W3-T).
   *
   * Empty without {@link BuildDrawListOptions.localAnims} — i.e. on every settled screen. A node whose
   * `transformOverrides` entry was in force is deliberately ABSENT rather than
   * approximated; see {@link LocalAnimFrame}.
   */
  localAnimFrames: ReadonlyMap<string, LocalAnimFrame>;
  /** Nodes the view-scale pass resolved an entry for — the patcher's `viewScale` refusal. Empty as above. */
  viewScaleCandidates: ReadonlySet<string>;
  /** Overlay records resolved against a non-empty clip chain — the patcher's `overlayClip` refusal. As above. */
  overlayClipped: ReadonlySet<string>;
  stats: DrawListStats;
}

/**
 * A node's animated alpha, as the renderer's evaluator resolved it (Wave 2a).
 *
 * The two factors are the SAME two the walk composes: `mod` replaces `modulate.a` (and therefore CASCADES to the
 * subtree), `self` replaces `self_modulate.a` (the node's OWN paint alone). Null on a field means "the streamed
 * value stands" — a transform tween running beside no fade writes neither.
 *
 * This is the alpha twin of {@link BuildDrawListOptions.transformOverrides}, and it exists for the same reason: a
 * canvas repaints from the caller's state every frame, so an animated value has to reach the walk as an input
 * rather than as a style already written onto an element.
 */
export interface AlphaOverride {
  mod: number | null;
  self: number | null;
}

/** The two alphas the wire streams for a node, filled into a caller-owned pair. See {@link streamedAlphasOf}. */
export interface StreamedAlphas {
  /** `modulate.a`, falling back to `opacity` — the factor that CASCADES to the subtree. */
  mod: number;
  /** `self_modulate.a` — the node's OWN paint alone. */
  self: number;
}

/**
 * The streamed halves of a node's alpha, which {@link AlphaOverride} substitutes for.
 *
 * Exported because the tier-3 patcher has to answer the same question the walk answers — "what alpha is this node
 * painting at" — for a node it is NOT re-walking, and a restated two-liner there would be a second copy of a rule
 * this file owns. Fills a caller-owned pair so a subtree walk allocates nothing.
 */
export function streamedAlphasOf(node: MirrorNode, out: StreamedAlphas): StreamedAlphas {
  out.mod = node.modulate ? node.modulate.a : node.opacity;
  out.self = node.selfModulate ? node.selfModulate.a : 1;
  return out;
}

/** A cosmetic design-space translation applied to a node AND EVERYTHING UNDER IT. See `cosmeticOffsets`. */
export interface CosmeticOffset {
  dx: number;
  dy: number;
}

/**
 * The two spread answers a stateless build cannot derive from the state it was handed — both of them lookups into
 * what a PREVIOUS walk resolved, exactly as the DOM walk reads them out of its retained records.
 *
 * Without one, an owner-anchored floater rides its parent and a remote follower takes its own positional claim:
 * both are the DOM's own "cannot resolve" fallbacks, so the degraded answer is a legal spread rather than a hole.
 */
export interface SpreadRegistry {
  /** The cumulative shift of the control an `anchorOwnerId` floater is positioned from. */
  ownerDx(ownerId: string, fallbackDx: number): number;
  /** The shift of whatever content sits under a remote cursor's true game point (`hitTestShift`'s answer). */
  followerShift(gx: number, gy: number): number;
}

/**
 * What a build needs to paint SPINE STILLS inside the canvas instead of hoisting them (M3 A2).
 *
 * THREE QUESTIONS, and they are separate because they are answered by three different things.
 *
 * `boxFor` is the DOM overlay's own committed geometry — where the decoded `<img>` sits inside the node — which
 * this walk cannot derive: a `SpineSprite` streams no `localRect`, which is exactly why its record box is a 0x0
 * anchor and why the cover pass has had no opinion about spine until now. It comes from `overlay.spineQuads()`.
 *
 * `wanted` is the SELECTIVITY, and it carries a deliberate ONE-BUILD LAG. A quad is worth its VRAM only where a
 * hoisted `<img>` is actually WRONG — where the game paints something over the creature — and that is the cover
 * pass's answer, which is only available AFTER the walk that would have to emit the quad. So the caller banks
 * build N's answer and this reads it on build N+1; `spreadDxByNode` has the same discipline for the same reason.
 * The worst case is one frame of today's hoist, and today's hoist is what a refusal falls back to at every step.
 *
 * `admit` NAMES the clip for the build in progress and says whether its pixels are on the GPU — `spineSurfaces`'
 * residency call, wrapped by the caller because the pixels are a DOM element and this module never sees one.
 */
export interface SpineQuadSource {
  boxFor(nodeId: string): SpineQuadBox | null;
  wanted(nodeId: string): boolean;
  admit(nodeId: string): boolean;
  /**
   * Optional DOM-free geoclip emission at this semantic Spine position. The
   * native stage list is owned by the source; the facade observes its count so
   * painter order and command ranges remain one stream. `"pending"` suppresses
   * the raster fallback until a stage-owned artifact settles.
   */
  emitMeshes?(record: OverlayRecord, node: MirrorNode): number | "pending";
}

/**
 * The LATCHED WIRE-LOCAL of a map-quill stroke (R8) — `mirrorRenderer.pinnedStrokeLocal`'s twin, owned by the
 * caller because the latch is per-STREAM state and this module is stateless.
 *
 * A quill stroke's local transform is the DrawViewport's viewport→screen fit and is CONSTANT for the stroke's
 * life: the stroke never moves inside the viewport, and scrolling the map moves the MapDrawing ANCESTOR. A stale
 * viewport prefix on the producer side therefore drags finished annotations off the map — which is the literal
 * symptom in the user's "map drawings cannot be seen" — and the fix on both backends is to read a stroke's local
 * exactly once.
 *
 * LOCAL, NEVER GLOBAL, and the difference is the whole point: latching the composed global would freeze the
 * annotation ON SCREEN, so the map would scroll out from under it. Substituted for `node.transform` itself, so
 * BOTH `gGame` and `gRaw` carry it — this is a correction to what the wire SAID, not a cosmetic override.
 */
export interface PinnedLocalSource {
  /** The latched local for this stroke, latching `local` on first sight. Never called for anything else. */
  pin(id: string, local: Affine): Affine;
}

/**
 * One node's IDLE-LOOP pose for this frame (R4) — the numeric replacement for the CSS animation the DOM backend
 * puts on the same node, sampled by `canvas/idleAnim.ts` from `tweenLoop`'s phase.
 *
 * TWO CHANNELS, because the vocabulary has two shapes and they compose in different places (see the walk):
 *   * `pre`  — a PARENT-space translate, applied ahead of the node's own wire matrix. The enemy-intent bob: the
 *              game moves the HOLDER and its subtree rides along, which is what this spelling reproduces.
 *   * `post` — a node-LOCAL 2x3, applied after the composition. The orb spin and the map-point pulse: a rotation
 *              or a uniform scale about the node's own pivot. Local, so it cannot orbit the design origin — the
 *              failure the DOM backend needs a whole self-layer child to avoid.
 *
 * DRAWN ONLY, and only through `gRaw`. `gGame` — the pose a tap sends to the game — never sees either channel,
 * because the producer has PINNED these loops at rest and the game believes they are still there.
 *
 * The alpha half of the vocabulary (the proceed and end-turn glows) needs no channel here at all: it composes
 * into `alphaOverrides` at the renderer, which keeps an alpha-only idle frame inside the tier-3 patcher.
 */
export interface LocalAnim {
  pre: readonly number[] | null;
  post: readonly number[] | null;
}

/**
 * ONE NODE'S RENDERED GLOBAL under a local anim — the composition law of {@link LocalAnim}, as a function.
 *
 * Exported and shared rather than restated, because the tier-3 TRANSFORM patcher has to compute the pose this
 * walk WOULD have produced at a new phase, and two spellings of this law that drift are a wrong picture nobody
 * can see (the patched list is self-consistent; it is just not the list a rebuild would have written). The walk
 * below calls this, `listPatch.planTransform` calls this, and there is no third copy.
 *
 * `override` wins over the pre/local composition and `post` decorates whatever survives — see the call site for
 * why that order is the DOM's.
 */
export function composeLocalAnimGlobal(
  parentFinal: Affine,
  own: readonly number[] | null | undefined,
  override: readonly number[] | null,
  pre: readonly number[] | null,
  post: readonly number[] | null
): Affine {
  const ownDraw = pre !== null && own != null ? affineMul(pre as Affine, own as Affine) : own;
  let gRaw: Affine =
    override != null
      ? (override as Affine)
      : ownDraw == null
        ? // A transform-less node inherits; a `pre` on one still lands in its parent's space, which is where a
          // translate belongs whichever space the stream is in.
          pre !== null
          ? affineMul(parentFinal, pre as Affine)
          : parentFinal
        : affineMul(parentFinal, ownDraw as Affine);
  if (post !== null) {
    gRaw = affineMul(gRaw, post as Affine);
  }
  return gRaw;
}

/**
 * Everything the tier-3 TRANSFORM patcher needs to re-pose ONE local-anim subtree without walking the scene.
 *
 * THE ALGEBRA THIS EXISTS TO SERVE. A local anim never reaches `gGame` — it enters at `ownDraw`/`gRaw` only — so
 * the spread claim, the game pose and the input registry are blind to it BY CONSTRUCTION. And with no view-scale
 * stamp, no cosmetic offset and no clipper INSIDE the subtree (every one of those is a named refusal), every node
 * in the span draws at `m = Cᵢ · g`, with `Cᵢ = outer · T(dxᵢ, 0)` — one shared `outer` and the node's own spread
 * shift. So the whole span re-poses by a left-multiplier: paint quads, atlas regions, injected fx/spine/text quads
 * (which compose `record.transform ∘ local`) and the overlay records themselves.
 *
 * Which is why these matrices are enough: `base` and `wire` recompute `gRaw` at the new phase, `outer` and
 * `spreadDx` build the root's own `C`, and `drawn` is the pose currently IN the list — so the root's `D` is one
 * multiply and one inverse, and the per-node correction (zero for a translating anim, see `listPatch`'s
 * `THE SPREAD TERM`) is two multiply-adds off a `dx` the build already banks.
 */
export interface LocalAnimFrame {
  /** `gFinal` as this build wrote it — the pose the list currently holds for the node's own paint. */
  drawn: Affine;
  /**
   * The left-multiplier every node in the span SHARES: the accumulated view-scale stamp with this node's own
   * cosmetic offset folded into its translation.
   *
   * NOT the whole of `C` on a widened stage. There `gFinal` picks up a per-node `T(dx, 0)` between this and
   * `gRaw`, and `dx` is each node's own field claim — so the patcher composes `outer · T(dxᵢ, 0)` per node
   * instead of assuming one `C`. See `listPatch`'s `THE SPREAD TERM` for why that is still O(1) per command, and
   * {@link LocalAnimFrame.spreadRebased} for the one case where it is refused instead.
   */
  outer: Affine;
  /** The parent's rendered global — what this node composes against. */
  base: Affine;
  /** The node's OWN local matrix, after the map-quill latch. Null for a transform-less node. */
  wire: readonly number[] | null;
  /**
   * This node's own applied spread shift (design px, X only; 0 at factor 1) — the `T(dx, 0)` in its `C`.
   *
   * Banked HERE as well as in `spreadDxOut` so the root's own term cannot be read out of a map that a later build
   * has already re-keyed: it is written on the same line as `drawn`, from the same walk, for the same node.
   */
  spreadDx: number;
  /**
   * Were this span's field claims re-derived from the DRAWN pose (`?spreadEndpoint` AND a transform override on
   * an ANCESTOR)? Then `dx` stops being blind to the idle loop — `applyDrawnFieldRebase` reads `gRaw`, which
   * carries the anim — and the patcher must refuse (`spread`) rather than re-pose against a shift that a rebuild
   * would have moved. Constant over the span: an override INSIDE it is already `spanOverride`.
   */
  spreadRebased: boolean;
}

/**
 * THE CALLER'S HALF OF THE HOVERTIP SCALE — the two questions a stateless build cannot answer for itself, plus
 * the gate.
 *
 * Everything else the shared policy (`tipScaleLayout`) asks about is a fact of the tree or of this frame's
 * geometry, which the walk has; what it does NOT have is the anchor OWNER. A tip points at an arbitrary node —
 * a hand card, a creature, a reward row — that the walk may not have reached, and whose wide-screen shift is a
 * function of a chain this build has not composed yet. The caller answers it out of the state and the LAST
 * build's shifts, which is precisely what the DOM pass does (it reconstructs the owner from `cParentGlobal` +
 * the retained `record.spreadDx`) and what `SpreadRegistry.ownerDx` already ships for floaters. Worst case the
 * owner's shift is one build old, on a widened stage, for one frame.
 */
export interface CanvasTipScaleEnv {
  /** The readability-scaling setting ⇒ false skips the whole pass for the build. */
  enabled(): boolean;
  /** The topmost interactive rect containing a design point, excluding `exclude` — the resolve's leg (iii). */
  hitTestAt(x: number, y: number, exclude: string): string | null;
  /** The owner's DESIGN-space AABB as it is being drawn (spread shift folded in), or null if unplaceable. */
  ownerBoxOf(ownerId: string): TipAabb | null;
}

export interface BuildDrawListOptions {
  /**
   * Wide-screen stage factor (`stageWidth / 1920`). 1 = no spread, and then the whole spread walk short-circuits:
   * every node's `dx` is 0, `mFinal === mGame`, and no context object is allocated.
   */
  spreadFactor?: number;
  /** See {@link SpreadRegistry}. Null ⇒ the two fallbacks above. */
  spreadRegistry?: SpreadRegistry | null;
  /**
   * The view-scale environment (the readability setting + this backend's scene resolver).
   *
   * Absent or null means the caller does not request the pass: no node-type leaf is resolved, no stamp is measured,
   * `viewScaleStamps` stays empty, and the list keeps its unscaled values. A disabled `env.enabled()` is the same at
   * runtime, because it is read once per build and gates the whole feature on one hoisted boolean.
   */
  viewScaleEnv?: ViewScaleEnv | null;
  /**
   * The HOVERTIP-SCALE environment — the caller's half of `tipScaleLayout` (the anchor-owner resolve
   * and this backend's scene/type lookups). Absent or null means the pass never runs, on the same terms
   * `viewScaleEnv` states: no tip is measured, no stamp is folded, and the list is byte-identical to a build
   * without the feature. The readability-scaling setting reaches it through `enabled()`.
   *
   * The env's `drawnBoxOf` / `childIdsOf` are NOT what measures the tip's children — the walk does that inline,
   * at the pose it is drawing them at this frame (see the tip block in `walk`). What the caller answers is the
   * OWNER: any node on screen, which the walk may not have reached yet.
   */
  tipScaleEnv?: CanvasTipScaleEnv | null;
  /**
   * Per-node ABSOLUTE spread shift, written back for the caller to RETAIN — it is the map a {@link SpreadRegistry}
   * answers `ownerDx` out of on the NEXT build, which is why the builder does not keep it itself. Cleared and
   * refilled per build; left untouched (and therefore stale-but-harmless) while the stage is not widened.
   */
  spreadDxOut?: Map<string, number> | null;
  /**
   * …and WHICH FIELD FORMULA produced each of those shifts ({@link SpreadOut.fieldMode}), for the diagnostic seam
   * alone. Opt-in and absent in production: the answer separates "this node's claim was measured at the wrong
   * pose" (a field claimer whose rebase did not fire) from "this node never claims a field at all" (a rigid rider,
   * an anchor-algebra Control), which are different bugs with the same symptom and cannot be told apart from the
   * shift alone. Written on the same line as `spreadDxOut`, so the two can never describe different nodes.
   */
  spreadFieldModeOut?: Map<string, number> | null;
  /**
   * The stage-wide field audit's sink (`?spreadAudit=1`) — see {@link SpreadAudit}. Null in production and in every
   * spec that does not ask for it, and then not one comparison runs.
   */
  spreadAudit?: SpreadAudit | null;
  /** Per-node RENDERED global substitutions (the DOM walk's `transformOverride`) — tween/flight samples. */
  transformOverrides?: ReadonlyMap<string, readonly number[]> | null;
  /** Per-node animated alpha (see {@link AlphaOverride}). Empty whenever nothing is animating. */
  alphaOverrides?: ReadonlyMap<string, AlphaOverride> | null;
  /**
   * Per-node COSMETIC design-space translations, applied to the node and INHERITED by its whole subtree.
   *
   * The DOM backend's twin is the individual CSS `translate` property (`applyHeldLift`, `applyLocalOffset`): it
   * composes on top of the element's baked `matrix()` and, because the mirror's DOM nests a node's children under
   * it, moves the subtree for free. A flat draw list has no such nesting, so the offset is threaded down the walk
   * and added to each descendant's own drawn origin — which keeps a lifted card root and its art together.
   *
   * DRAWN ONLY. `mGame` — what a tap sends to the game — never sees it, exactly as the DOM lift "never affects
   * hit-testing or what's sent to the game".
   */
  cosmeticOffsets?: ReadonlyMap<string, CosmeticOffset> | null;
  /**
   * Read back the RENDERED global (pre-cosmetic-offset) of a handful of named nodes.
   *
   * The caller needs a node's last-painted placement to compose the NEXT frame's cosmetic offset against it
   * (`scrollRenderedY`). Opt-in and id-keyed rather than a whole-scene map: a per-node `Map.set` over ~3000 nodes
   * would cost more than everything it serves. `parentTy` is the parent's rendered origin Y, so the caller can
   * recover the PARENT-RELATIVE painted Y the DOM backend reports from its element's baked `matrix()`.
   */
  captureGlobals?: { ids: ReadonlySet<string>; out: Map<string, CapturedGlobal> } | null;
  /**
   * Subtree roots the walk must not enter at all — no paint, no overlay record, no hit surface, no descent.
   *
   * The DOM backend's twin is its static-background BUILD HOLD, which folds into `visit`'s `hidden` rather than
   * its `suppressed` precisely so the subtree is never CONSTRUCTED: no element, no atlas canvas, no gsw shader or
   * particle binding below it. A draw list has no construction to hold back, so the equivalent is simply not
   * walking — which is also strictly cheaper than walking a subtree that classifies every node `skip`.
   */
  skipRoots?: ReadonlySet<string> | null;
  /**
   * Per-node stretched paint widths (the DOM walk's `renderWidthOverride`). The spread walk fills these itself
   * for an anchored SPAN it widened; this map is the escape hatch for a caller that wants to force one, and the
   * spread's own answer wins where both apply.
   */
  renderWidthOverrides?: ReadonlyMap<string, number> | null;
  /**
   * THE EFFECT-SURFACE SOURCE (M2) — `fxSurfaces`' registry.
   *
   * ABSENT IS THE DEFAULT AND IT MUST STAY BYTE-IDENTICAL. Without one, the `overlay` branch pushes a record and
   * nothing else. That keeps the offline draw-list gate (which has no GL, no gsw runtime and therefore no surfaces)
   * producing its source-free list, float for float — the same contract `viewScaleEnv` has one option up.
   *
   * With one, a shader or particle record ALSO emits a quad at the node's own paint index (see
   * `paintSpec.emitFxQuad`), which is the whole of M2's "effects into the canvas".
   */
  fxSource?: FxQuadSource | null;
  /**
   * Strict single-canvas-only no-op admission. The caller must return true
   * only for a typed proof of zero pixels; it is never a fallback for an
   * unavailable effect producer.
   */
  stageOwnedNoop?: (input: NodePaintInput, record: OverlayRecord) => boolean;
  /**
   * THE SPINE-STILL SOURCE (M3 A2) — see {@link SpineQuadSource}.
   *
   * ABSENT MUST STAY BYTE-IDENTICAL, exactly like `fxSource` one option up: without one the
   * `overlay` branch pushes a record and nothing else, the cover pass keeps its "a 0x0 record has no extent, so
   * no opinion" rule, and the offline gate — which has no DOM, no decoded image and therefore no source — builds
   * the same list float for float.
   */
  spineSource?: SpineQuadSource | null;
  /**
   * THE CARD-TRAIL SOURCE (M3 A4) —
   * `cardTrailState`'s integrator.
   *
   * ABSENT IS BYTE-IDENTICAL, exactly like `fxSource` and `spineSource` above: without one the `overlay` branch
   * pushes a record and nothing else, which is what the offline draw-list gate builds (it has no renderer, so no
   * point histories and no source).
   */
  trailSource?: TrailQuadSource | null;
  /**
   * THE TEXT-RASTER SOURCE (M4) — see {@link TextQuadSource}.
   *
   * ABSENT IS THE DEFAULT AND IT MUST STAY BYTE-IDENTICAL, the same contract the three sources above hold: without
   * one the `overlay` branch pushes a text record and nothing else, and the offline draw-list gate — which has no
   * 2D context, no font and therefore no raster — builds the same list float for float.
   *
   * CLASSIFICATION IS UNTOUCHED EITHER WAY. A text node stays `overlay` whether or not its pixels reach the list,
   * exactly as a shader node does under M2, so the union oracle the offline gate checks is the same set on both
   * settings. That is why turning this on cannot move a single number in that gate.
   */
  textSource?: TextQuadSource | null;
  /**
   * THE GLYPH SOURCE — see {@link TextGlyphSource}.
   *
   * ABSENT IS BYTE-IDENTICAL on the rule every source above holds, and here it is also the ONLY thing that keeps
   * the offline draw-list gate meaningful: that gate has no GL context, no wasm and therefore no shaper, so a
   * build without one must produce the list it always did, float for float.
   *
   * ASKED BEFORE `textSource`, AND THE TWO ARE EXCLUSIVE PER LABEL. A label whose outline the glyph path drew
   * must not also be rastered and blitted on top of itself — that is double ink at a half-pixel offset, which
   * reads as a bolder, blurrier label rather than as an obvious bug. Every one of `glyphPass`'s six refusals
   * falls straight through to the raster path below it, so "glyphs first" costs nothing when it declines — which
   * it now does rarely, since the outline stopped being one of them.
   */
  glyphSource?: TextGlyphSource | null;
  /**
   * THE FIDELITY-FLOOR CENSUS for the runs this build emits — see `paintSpec`'s {@link GlyphFloorProbe}.
   *
   * DIAGNOSTIC, and absent is the default: with no probe not one float in the built list changes, which is the
   * rule every option here holds and what keeps the offline gate byte-identical. Only the RENDERER installs one,
   * because only it knows the stage's design-to-device factor.
   */
  glyphFloor?: GlyphFloorProbe | null;
  /**
   * THE DEVICE-PIXEL SNAP for label quads — the grid and the per-label rest test. See `paintSpec`'s
   * {@link TextSnap} for what the snap buys, what it costs, and why rest is asked of the label rather than of the
   * frame.
   *
   * ABSENT IS THE DEFAULT AND IT IS BYTE-IDENTICAL, on the rule every option here holds: without one the composed
   * matrix is passed through untouched, so the offline gate and every pre-existing spec keep the floats they had.
   *
   * STATEFUL, and the caller owns that state: `atRest` is called once per label per build and RECORDS as it
   * answers, so the same object must live across builds.
   */
  textSnap?: TextSnap | null;
  /**
   * PIN A MAP-QUILL STROKE'S WIRE-LOCAL (R8). Absent ⇒ nothing is pinned and every matrix below remains streamed,
   * which is the offline gate's unpinned mode.
   *
   * Consulted for a node carrying stroke geometry and nothing else — see
   * {@link PinnedLocalSource} and the call site.
   */
  pinnedLocals?: PinnedLocalSource | null;
  /**
   * PER-NODE IDLE-LOOP POSES (R4) — see {@link LocalAnim}. Absent ⇒ no node is animated and every matrix remains
   * at its streamed pose, which is the offline gate's no-animation mode.
   */
  localAnims?: ReadonlyMap<string, LocalAnim> | null;
  /**
   * PER-NODE PAINT SUBSTITUTES (R6) — a shallow clone of the node carrying a DIFFERENT
   * frame's texture fields, used for this node's paint and for nothing else.
   *
   * An enemy intent's glyph is a frame ANIMATION the producer freezes game-side: the wire ships the whole frame
   * set once (sticky) and forces the node's `textureUrl`/`textureRegion`/`textureMargin` to frame 0, leaving the
   * client to cycle the rest. On the DOM backend that is a canvas blit onto the node's own atlas canvas; here it
   * is simply a different source rect, so the substitute needs no new emitter and `emitAtlasRegion` is untouched.
   *
   * Absent ⇒ every node paints exactly what the wire streamed, which is what the offline gate builds. The clone
   * carries the same `parentId`/`name`/`nodeType`, so the walk, the spread, the clip chain and the hit entry are
   * all identical to the wire node's by construction.
   */
  frameSubstitutes?: ReadonlyMap<string, MirrorNode> | null;
  /** Optional canvas-owned CouchCoop HUD paint; absent leaves the draw list byte-identical. */
  handRaiseChrome?: { emit(input: NodePaintInput, scratch: PaintScratch, sink: PaintSink): number } | null;
  /** Reused sibling sorts across builds. Optional; without one every parent is sorted every build. */
  paintOrderCache?: PaintOrderCache;
  /**
   * Reused scene-identity / touch-owner walk cache. Optional; without one both walks run per node per build, as
   * they did before. RESET at the top of every build — see {@link HitMemo} for why the lifetime is exactly that.
   */
  hitMemo?: HitMemo;
  /** Reused command payloads. Optional; one is created per build otherwise. */
  scratch?: PaintScratch;
  /** Build hit entries (default true). Off is for a pure paint benchmark. */
  hitTest?: boolean;
  /** Dev/test invariant assertions (default: `paintOrderAssertsOn()`). */
  assert?: boolean;
  /** Texture page sizes; defaults to `textureCache.naturalSize`. See `paintSpec`'s `EmitOptions`. */
  textureSize?: (url: string) => { width: number; height: number } | null;
  /** `reset()` the list before filling it (default true). */
  resetList?: boolean;
  /**
   * Called once per visited node with its classification. A pure OBSERVER seam — the offline gate uses it to
   * compare the builder's `canvas ∪ overlay` set against the independent oracle without the builder having to
   * retain a per-node map it would otherwise never need.
   */
  onNode?: (id: string, cls: NodeClass) => void;
}

const IDENTITY_TINT = { r: 1, g: 1, b: 1 } as const;
/**
 * The walk's own `streamedAlphasOf` destination — module-level and reused, for the reason `PaintScratch` is: the
 * walk visits every node in the scene, and a fresh pair per node would put ~3000 objects a build on the wire's
 * cadence. A single builder drives a stage and the walk is synchronous, so it cannot be observed half-filled.
 */
const streamedScratch: StreamedAlphas = { mod: 1, self: 1 };
/** The default emit options — shared, so a build with no texture-size override allocates nothing per node. */
/** …and the fx-quad set every build without an `fxSource` reports, so the flag-off path allocates none. */
const NO_FX_QUAD_IDS: ReadonlySet<string> = new Set<string>();
/** …and its spine twin. */
const NO_SPINE_QUAD_IDS: ReadonlySet<string> = new Set<string>();
/** …and its trail twin. */
const NO_TRAIL_QUAD_IDS: ReadonlySet<string> = new Set<string>();
/** …and its text twin (M4). */
const NO_TEXT_QUAD_IDS: ReadonlySet<string> = new Set<string>();

// --- the COVER PASS scratch ------------------------------------------------------------------------------------
//
// Module-level and grow-only, for the same reason `PaintScratch` is: the cover pass runs on every build and the
// two arrays it fills are the only per-node state it keeps, so allocating them per build would put a ~1000-entry
// Float64Array on the wire's cadence. A single builder drives a stage (see `canvasRenderer`), and the pass is a
// synchronous post-step of one build, so a shared scratch cannot be observed half-filled.
let coverOrders = new Int32Array(512);
let coverBoxes = new Float64Array(512 * 4);
let coverCount = 0;

function coverReset(): void {
  coverCount = 0;
}

function coverGrow(): void {
  if (coverCount < coverOrders.length) {
    return;
  }
  const orders = new Int32Array(coverOrders.length * 2);
  orders.set(coverOrders);
  coverOrders = orders;
  const boxes = new Float64Array(coverBoxes.length * 2);
  boxes.set(coverBoxes);
  coverBoxes = boxes;
}

/**
 * Answer {@link OverlayRecord.coveredAbove} for every record that needs it.
 *
 * THE QUESTION. A DOM overlay above ONE canvas element can only paint above the whole canvas. So the fact the
 * overlay needs about each surface is "does the game paint anything over you?" — because if it does, hoisting the
 * surface reproduces the effect at the cost of hiding the content that belongs on top of it, which for a
 * full-screen background VFX layer means hiding the game. `overlay.ts` owns what to DO about that; this owns the
 * measurement.
 *
 * THE MEASUREMENT. `coverOrders` / `coverBoxes` hold, in ascending paint order, the placed-box AABB of every node
 * the draw list actually painted. One backward pass turns them into SUFFIX UNIONS — `suffix[i]` is the union AABB
 * of every painted node from `i` on — after which each record is one binary search plus one AABB intersection.
 * O(n) rather than the O(n·m) a per-node scan would be, and the suffix union is the CONSERVATIVE direction: it is
 * a superset of the real later paint, so the pass can answer "covered" for a surface nothing truly overlaps, never
 * the reverse. That bias is the safe one — it withholds an effect rather than letting one hide the game.
 *
 * A ZERO-AREA record is left alone (`coveredAbove` stays false): a `GpuParticles2D` and a playing `SpineSprite`
 * stream no `localRect`, so their record box is a 0x0 anchor at the node origin and their real extent lives in a
 * gsw canvas that grows around it. There is no box to intersect, so the pass has no opinion.
 *
 * …UNLESS a {@link SpineQuadSource} is configured, which is the one thing that can hand a SPINE record a real
 * extent: the DOM overlay knows where the decoded still sits, because it wrote that rect onto the `<img>`. With
 * one, a spine record is measured on THAT box, which is what turns "the cover pass has no opinion about spine"
 * into the selectivity rule A2 is built on. Without one nothing here changes at all.
 */
function markCoveredOverlays(records: OverlayRecord[], spine: SpineQuadSource | null): void {
  const n = coverCount;
  if (n === 0) {
    return;
  }
  // Suffix unions, in place, from the back. `coverBoxes[i]` becomes the union of the original [i, n).
  for (let i = n - 2; i >= 0; i--) {
    const at = i * 4;
    const next = at + 4;
    if (coverBoxes[next] < coverBoxes[at]) coverBoxes[at] = coverBoxes[next];
    if (coverBoxes[next + 1] < coverBoxes[at + 1]) coverBoxes[at + 1] = coverBoxes[next + 1];
    if (coverBoxes[next + 2] > coverBoxes[at + 2]) coverBoxes[at + 2] = coverBoxes[next + 2];
    if (coverBoxes[next + 3] > coverBoxes[at + 3]) coverBoxes[at + 3] = coverBoxes[next + 3];
  }
  for (const record of records) {
    const spineBox = spine !== null && record.kind === "spine" ? spine.boxFor(record.id) : null;
    if (spineBox === null && (!(record.w > 0) || !(record.h > 0))) {
      continue;
    }
    // First painted node STRICTLY after this record in paint order.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (coverOrders[mid] > record.order) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    if (lo >= n) {
      continue; // nothing paints after it — hoisting is exactly right
    }
    const at = lo * 4;
    const box = spineBox === null ? recordAabb(record) : spineAabb(record, spineBox);
    record.coveredAbove =
      coverBoxes[at] < box.maxX &&
      coverBoxes[at + 2] > box.minX &&
      coverBoxes[at + 1] < box.maxY &&
      coverBoxes[at + 3] > box.minY;
  }
}

/**
 * A SPINE record's AABB, from the still's own node-local rect — the same composition `emitSpineQuad` paints and
 * `mountStill` writes onto the element, so the pass measures the pixels that are actually on screen.
 */
function spineAabb(record: OverlayRecord, box: SpineQuadBox): { minX: number; minY: number; maxX: number; maxY: number } {
  const s = box.scale;
  const m = affineMul(record.transform, [s, 0, 0, s, box.tx, box.ty]);
  return boxAabb(m, box.frameW, box.frameH);
}

/** A record's own AABB, from its placement matrix and box — the same four-corner transform the cover boxes use. */
function recordAabb(record: OverlayRecord): { minX: number; minY: number; maxX: number; maxY: number } {
  return boxAabb(record.transform, record.w, record.h);
}

function boxAabb(m: Affine | readonly number[], w: number, h: number): { minX: number; minY: number; maxX: number; maxY: number } {
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

/** Fill `list` with everything `state` paints, in order. See the header for what is and is not composed yet. */
export function buildDrawList(
  state: MirrorState,
  list: DrawList<string>,
  options: BuildDrawListOptions = {}
): DrawListBuild {
  const assert = options.assert ?? paintOrderAssertsOn();
  const order = buildPaintOrder(state, options.paintOrderCache, { assert });
  const nodes = state.nodes;
  const scratch = options.scratch ?? createPaintScratch();
  // CLEARED HERE, and this is the only place it may be: the memo's answers are properties of the node map as it
  // stands right now (an ancestor swap, or a change in how many event options are visible, moves them), so its
  // whole lifetime is this call. A caller that supplies none gets the un-memoized walks.
  const hitMemo = options.hitMemo ?? null;
  hitMemo?.reset();
  const wantHits = options.hitTest !== false;
  const transformOverrides = options.transformOverrides ?? null;
  const renderWidthOverrides = options.renderWidthOverrides ?? null;
  const alphaOverrides = options.alphaOverrides ?? null;
  const cosmeticOffsets = options.cosmeticOffsets ?? null;
  const capture = options.captureGlobals ?? null;
  const skipRoots = options.skipRoots ?? null;
  const fxSource = options.fxSource ?? null;
  const fxQuadIds: Set<string> = fxSource === null ? (NO_FX_QUAD_IDS as Set<string>) : new Set();
  const stageOwnedNoop = options.stageOwnedNoop ?? null;
  const stageOwnedNoopIds = new Set<string>();
  const spineSource = options.spineSource ?? null;
  const spineQuadIds: Set<string> = spineSource === null ? (NO_SPINE_QUAD_IDS as Set<string>) : new Set();
  // Trail emission never changes CLASSIFICATION — a trail node stays an `overlay` node, so the union oracle the
  // offline gate asserts remains independent of whether a live trail source has points to emit.
  const trailSource = options.trailSource ?? null;
  const trailQuadIds: Set<string> = trailSource === null ? (NO_TRAIL_QUAD_IDS as Set<string>) : new Set();
  const textSource = options.textSource ?? null;
  const glyphSource = options.glyphSource ?? null;
  const glyphFloor = options.glyphFloor ?? null;
  // EITHER text source populates it — the glyph path publishes into the same set (its consumers ask whether the
  // canvas drew the label, not how), so the shared empty sentinel is only safe when NEITHER is installed.
  const textQuadIds: Set<string> =
    textSource === null && glyphSource === null ? (NO_TEXT_QUAD_IDS as Set<string>) : new Set();
  // Guarded to a finite positive grid rather than taken as given: a NaN factor would put NaN in a quad matrix,
  // and a NaN matrix draws nothing at all — a whole screen of text lost to one bad number.
  const textSnap =
    options.textSnap && Number.isFinite(options.textSnap.perDesignPx) && options.textSnap.perDesignPx > 0
      ? options.textSnap
      : null;
  const pinnedLocals = options.pinnedLocals ?? null;
  const localAnims = options.localAnims ?? null;
  const frameSubstitutes = options.frameSubstitutes ?? null;

  // --- the wide-screen spread ------------------------------------------------------------------------------
  //
  // `spreading` is the single gate: false on a 16:9 stage (the overwhelmingly common case), and then not one line
  // below runs — no scene resolve, no context object, no per-node `Map.set`.
  const spreadFactor = options.spreadFactor ?? 1;
  const spreading = spreadFactor !== 1;
  const spreadDxOut = options.spreadDxOut ?? null;
  const spreadFieldModeOut = options.spreadFieldModeOut ?? null;
  const spreadAudit = options.spreadAudit ?? null;
  const spreadEnv: SpreadEnv | null = spreading ? spreadEnvFor(nodes, options.spreadRegistry ?? null, spreadFactor) : null;
  // R6 M2 — re-base an ANIMATED node's field claim at the pose it is drawn at (`?spreadEndpoint`, shared with the
  // DOM writer, default ON). Hoisted per build like `spreading` itself, and false at 16:9 by construction.
  const spreadRebase = spreading;
  const spreadScratch: SpreadOut | null = spreading ? createSpreadOut() : null;
  const spreadRoot: SpreadCtx | null = spreading ? rootSpreadCtx(spreadFactor, IDENTITY_AFFINE) : null;
  /**
   * A DEPTH-INDEXED stack of reusable child contexts, and why the walk does not just allocate one per node.
   *
   * The wide-screen branch builds a fresh `SpreadCtx` for EVERY node it visits — and on a wide screen (the phone
   * this round is gated on is 2712x1220) that branch is live for the whole tree, so it is ~1500 short-lived
   * nine-field objects per build, every build. The Aug-28 combat trace put the collector at 4.4 % of frame self
   * time.
   *
   * WHAT THIS IS AND IS NOT WORTH, measured rather than assumed. On desktop V8 the pool is worth NOTHING: a
   * 1501-node build measured 3.34 ms with per-node allocation and 3.30 ms pooled, i.e. inside the noise. Nursery
   * scavenging of small short-lived objects is very nearly free there, and the walk's real allocation cost turned
   * out to be elsewhere (the per-node `names` array and joined path string that `sceneIdentityOf` no longer
   * builds — see `HitMemo`, which measured 41 % off the same build). This is kept because it is strictly less
   * garbage on a device whose collector is not desktop V8's, and it is CHEAP and pinned by tests — but it is
   * UNPROVEN, and the phone trace is the only thing that can settle it. Do not quote it as a win.
   *
   * WHAT MAKES REUSE SAFE, and it is one property: a context's ONLY consumer is the child recursion it is handed
   * to, and that recursion is synchronous and fully nested. `computeSpread` reads its `ctx` into locals and keeps
   * no reference; nothing else ever sees one. So a context is dead the moment the child loop returns, and the
   * acquire/release pair below brackets exactly that — which makes the free-list a plain stack indexed by walk
   * DEPTH, never more than the tree is deep.
   *
   * Per BUILD rather than per renderer: ~30 objects for a deep tree is not worth another lifetime to reason
   * about, and it keeps the pool from outliving a scene that shrank.
   */
  const spreadPool: SpreadCtx[] = [];
  let spreadDepth = 0;
  function takeSpreadCtx(gGame: SpreadAffine, parentWidth: number, out: SpreadOut): SpreadCtx {
    let ctx = spreadPool[spreadDepth];
    if (ctx === undefined) {
      // Every field assigned in the same order, always, so V8 keeps one hidden class for the whole pool.
      ctx = {
        parentDx: 0,
        deltaParentWidth: 0,
        anchorDelta: 0,
        rideDx: 0,
        parentDxProp: false,
        parentWidth: 0,
        parentGlobal: gGame,
        containerChildAlign: null,
        containerChildVertical: false
      };
      spreadPool.push(ctx);
    }
    spreadDepth++;
    ctx.parentDx = out.childParentDx;
    ctx.deltaParentWidth = out.childDeltaParentWidth;
    ctx.anchorDelta = out.childAnchorDelta;
    ctx.rideDx = out.childRideDx;
    ctx.parentDxProp = out.childParentDxProp;
    ctx.parentWidth = parentWidth;
    // The children's anchor algebra lifts its claim by the parent's TRUE x-basis, and a local-space child
    // composes against the true global — both unshifted, like the DOM's `childParentGlobal`.
    ctx.parentGlobal = gGame;
    ctx.containerChildAlign = out.childContainerAlign;
    ctx.containerChildVertical = out.childContainerVertical;
    return ctx;
  }
  if (spreading && spreadDxOut) {
    spreadDxOut.clear();
  }
  if (spreading && spreadFieldModeOut) {
    spreadFieldModeOut.clear();
  }
  if (spreadAudit !== null) {
    // Re-armed even at F = 1, where it will report 0 of 0 — an empty report from a stage that cannot spread must
    // not read like a clean one from a stage that can.
    resetSpreadAudit(spreadAudit);
  }

  // --- the view scale --------------------------------------------------------------------------------------
  //
  // `viewScaling` is the single gate, hoisted the same way `spreading` is: false without an env (or with
  // readability scaling disabled), and then not one line below runs — no `nodeTypeLeaf`, no scene resolve, no `Map.set`.
  const viewScaleEnv = options.viewScaleEnv ?? null;
  const viewScaling = viewScaleEnv !== null && viewScaleEnv.enabled();
  // The stamps are measured in WIDENED-design space (the spread shift is already in `gSpread`), so the on-screen
  // clamp has to know how wide the stage really is — the DOM pass computes the same `designW`.
  const viewScaleDesignW = MIRROR_DESIGN_WIDTH * spreadFactor;
  const viewScaleStamps: ViewScaleStampIndex = new Map();

  // --- the HoverTip scale ------------------------------------------------------------------------------------
  //
  // Same shape as the view scale above, one gate, and the same "no env ⇒ not one line runs" contract. What is
  // different is WHEN the stamp can be known: a view-scale item is measured from its OWN box, so the walk can
  // stamp it on arrival, while a tip's enlargement is measured from the union of its CHILDREN — which the walk
  // has not reached yet. So the tip block measures its children ahead of the descent (`measureTipChildBox`) and
  // only then folds the stamp into the product its subtree inherits.
  const tipScaleEnvOption = options.tipScaleEnv ?? null;
  const tipScaling = tipScaleEnvOption !== null && tipScaleEnvOption.enabled();
  /** This frame's measured tip-child boxes, keyed by child id — filled per tip, read by `tipLayoutEnv`. */
  const tipChildBoxes = new Map<string, TipAabb>();
  /**
   * A SECOND spread scratch, for the child pre-measure only.
   *
   * The walk's own `spreadScratch` has already been consumed into the tip's `childSpread` by the time the tip
   * block runs, so reusing it would be safe TODAY and silently wrong the day anything between them reads it back.
   * Allocated lazily: a stage with no tooltip (or with readability scaling disabled) never makes one.
   */
  let tipSpreadScratch: SpreadOut | null = null;
  /**
   * PRODUCER-ORDER children, parent → ids, built at most once per build and only for a build with a tooltip in it.
   *
   * `order.childrenOf` is this backend's Z-SORTED paint order; the DOM's `childIdsByParent` is the producer's
   * pre-order (`state.orderedIds`). For the tip's own child UNION the difference cannot matter — a union is
   * order-free — but `resolveVisualOwnerId`'s leg (ii) returns the FIRST painting descendant, and there the two
   * orders can name different nodes the moment a sibling carries a `z_index` or `show_behind_parent`. That is the
   * same "two nearly-identical walks" class as the 12-px owner divergence this round found and fixed, so the
   * shared policy is given the DOM's order rather than nearly it.
   *
   * The z-sort is stable within equal z, so on most scenes this map's lists equal `order.childrenOf`'s — which is
   * exactly why the difference is invisible until it is not.
   */
  let tipProducerChildren: Map<string, string[]> | null = null;
  function producerChildIdsOf(id: string): readonly string[] | undefined {
    if (tipProducerChildren === null) {
      tipProducerChildren = new Map();
      for (const nodeId of state.orderedIds) {
        const parentId = nodes.get(nodeId)?.parentId;
        if (parentId == null || !nodes.has(parentId)) {
          continue;
        }
        const list = tipProducerChildren.get(parentId);
        if (list) {
          list.push(nodeId);
        } else {
          tipProducerChildren.set(parentId, [nodeId]);
        }
      }
    }
    return tipProducerChildren.get(id);
  }
  /**
   * The shared policy env (`tipScaleLayout`), assembled from the two halves that know different things: the WALK
   * answers the tree and the geometry it is drawing this frame, the CALLER answers the anchor owner — an
   * arbitrary node the walk may not have reached, which its retained state can place and this build cannot.
   */
  const tipLayoutEnv: TipScaleEnv | null =
    tipScaling && tipScaleEnvOption !== null
      ? {
          designW: () => viewScaleDesignW,
          nodeOf: (id) => nodes.get(id),
          childIdsOf: producerChildIdsOf,
          // A CHILD is answered from this frame's own measure; anything else is the owner, and goes to the caller.
          drawnBoxOf: (id) => tipChildBoxes.get(id) ?? tipScaleEnvOption.ownerBoxOf(id),
          typeLeafOf: (id) => {
            const node = nodes.get(id);
            return node ? nodeTypeLeaf(node.nodeType) : null;
          },
          sceneFileOf: (id) => resolveSceneInfo(id, nodes)?.file ?? null,
          hitTestAt: (x, y, exclude) => tipScaleEnvOption.hitTestAt(x, y, exclude),
          // The owner's own drawn ORIGIN, for the visual-owner resolve's leg (iii). Its box is the caller's
          // answer, so its origin is too — asking the walk would be asking about a node it has not reached.
          originOf: (id) => {
            const box = tipScaleEnvOption.ownerBoxOf(id);
            return box === null ? null : { x: box.x, y: box.y };
          },
          parentIdOf: (id) => nodes.get(id)?.parentId,
          // THIS build's stamps, as far as the walk has got. A tip's owner paints before the tip does (tooltips
          // are drawn on top of what they point at), so the stamp that would move the owner is already in.
          stampOf: (id) => viewScaleStamps.get(id)
        }
      : null;
  // --- what the TRANSFORM patcher is handed (R7 W3-T) ----------------------------------------------------------
  //
  // All three are filled ONLY when something is animating locally, which is the same "null rather than empty" rule
  // `cosmeticOffsets` takes and for the same reason: a settled screen must not pay a `Set.add` per node for a
  // structure that can never be asked a question. With nothing armed they stay empty and this
  // whole seam is three null checks per build.
  const trackingLocalAnims = localAnims !== null;
  const localAnimFrames = new Map<string, LocalAnimFrame>();
  /**
   * Every node the view-scale pass RESOLVED AN ENTRY FOR, whether or not it produced a stamp.
   *
   * The membership that matters is "could this node's stamp change if it moved", and that is strictly wider than
   * "has a stamp": `computeViewScaleStamp` answers null for a box outside the design stage, so a node the anim
   * moves INTO view gains one — a structural change to the list the patcher cannot express.
   */
  const viewScaleCandidates = new Set<string>();
  /**
   * Overlay records whose `clip` was resolved against a NON-EMPTY enclosing chain.
   *
   * `intersectOverlayClip` returns null when the placed box already sits inside the intersection, which is the
   * common case — so a record under a clipper can flip between "no crop" and "cropped" purely by moving. The
   * clipper itself is outside the span (its own rect does not move), so `clipRanges` cannot see this; the record
   * is where the staleness would land, and this is the set that refuses it.
   */
  const overlayClipped = new Set<string>();

  if (options.resetList !== false) {
    list.reset();
  }
  coverReset();

  const overlayRecords: OverlayRecord[] = [];
  // See `DrawListBuild.backstopOrder`. -1 is "this screen paints no full-stage opaque fill", which is the answer
  // for every combat frame — the backstops are dialogs.
  let backstopOrder = -1;
  let backstopAlpha = 0;
  let backstopBlack = false;
  let handRaiseChromeCommand = -1;
  let handRaiseAnchorId: string | null = null;
  const backstopDesignW = MIRROR_DESIGN_WIDTH * spreadFactor;
  const hitEntries: HitEntry[] = [];
  const ranges = new Map<string, NodeCommandRange>();
  const nodePaintInputs = new Map<string, NodePaintInput>();
  const clipRanges = new Map<string, ClipCommandRange>();
  // A caller that explicitly appends must not receive invented ownership for
  // the preceding stream. It is intentionally marked unknown so a dirty planner
  // declines rather than replays through an unmodelled command.
  const onNode = options.onNode;
  const textures = new Set<string>();
  const overlayByKind: Record<OverlayKind, number> = { text: 0, shader: 0, particles: 0, spine: 0, trail: 0 };
  const stats: DrawListStats = {
    nodes: nodes.size,
    ordered: order.ids.length,
    canvas: 0,
    overlay: 0,
    skip: 0,
    silent: 0,
    overlayByKind,
    fxQuads: 0,
    spineQuads: 0,
    trailQuads: 0,
    textQuads: 0,
    textGlyphLabels: 0,
    textGlyphRuns: 0,
    commands: 0,
    quads: 0,
    ninePatches: 0,
    polylines: 0,
    glyphRuns: 0,
    clips: 0,
    maxClipDepth: 0,
    textures: 0,
    hitEntries: 0
  };

  // The sink is the ONLY place the list is touched for paint, so the per-kind counters cannot drift from it.
  const sink: PaintSink = {
    quad(view, texture) {
      list.pushQuad(view, texture);
      stats.quads++;
      if (texture) {
        textures.add(texture);
      }
    },
    ninePatch(view, texture) {
      list.pushNinePatch(view, texture);
      stats.ninePatches++;
      if (texture) {
        textures.add(texture);
      }
    },
    polyline(view) {
      list.pushPolyline(view);
      stats.polylines++;
    },
    glyphs(view) {
      list.pushGlyphs(view);
      stats.glyphRuns++;
    }
  };

  const emitOptions = { textureSize: options.textureSize };

  /**
   * THE TIP CHILD PRE-MEASURE: where the walk WOULD draw one direct child of a tip set, one step early.
   *
   * A tooltip's enlargement is a scale about a pivot chosen from the union of its children's boxes, so the stamp
   * cannot be known when the walk arrives at the tip root — and it has to be known there, because the whole
   * subtree inherits it. This runs the same composition the recursion below runs, for the tip's direct children
   * only (never deeper: the union is over DIRECT children, `tipScaleLayout.tipChildBoxes`), and hands back the
   * design-space AABB.
   *
   * IT IS THE WALK'S OWN LAW, minus two legs that provably cannot apply to a tip child, named so a reader can
   * check rather than trust: the map-quill LOCAL LATCH (`pinnedLocals`, gated on `linePoints` + `isMapStrokeNode`
   * — a tip child is not a map stroke) and the FRAME SUBSTITUTE (a shallow clone differing only in texture
   * fields, which no geometry here reads). Everything that CAN move a tip child is here: the transform override a
   * tween writes, the idle-loop composition, and the wide-screen field claim — including its drawn-pose rebase,
   * because a tip that is animating in is exactly a subtree whose claim must follow where it is drawn.
   *
   * Null when the child has no box to measure.
   */
  const measureTipChildBox = (
    childId: string,
    tipGGame: Affine,
    tipGRaw: Affine,
    childSpreadCtx: SpreadCtx | null,
    tipDrawnMoved: boolean
  ): TipAabb | null => {
    const node = nodes.get(childId);
    if (!node || node.localRect == null) {
      return null;
    }
    const own = node.transform;
    const gGame: Affine = own == null ? tipGGame : affineMul(tipGGame, own as Affine);
    const override = transformOverrides?.get(childId) ?? null;
    const anim = localAnims === null ? null : (localAnims.get(childId) ?? null);
    const gRaw: Affine =
      anim === null
        ? override != null
          ? (override as Affine)
          : own == null
            ? tipGRaw
            : affineMul(tipGRaw, own as Affine)
        : composeLocalAnimGlobal(tipGRaw, own, override, anim.pre, anim.post);
    let dx = 0;
    if (childSpreadCtx !== null && spreadEnv !== null) {
      const scratch = (tipSpreadScratch ??= createSpreadOut());
      const spreadBox = spreadDrawBox(node);
      computeSpread(childId, node, childSpreadCtx, gGame, spreadBox, spreadFactor, spreadEnv, scratch);
      if (spreadRebase && (tipDrawnMoved || override != null)) {
        applyDrawnFieldRebase(scratch, node, gRaw, spreadBox, spreadFactor);
      }
      dx = scratch.dx;
    }
    const gSpread: Affine = dx === 0 ? gRaw : [gRaw[0], gRaw[1], gRaw[2], gRaw[3], gRaw[4] + dx, gRaw[5]];
    return designAabbOf(gSpread, node.localRect);
  };

  const walk = (
    id: string,
    parentGame: Affine,
    parentFinal: Affine,
    cascadeAlpha: number,
    tintR: number,
    tintG: number,
    tintB: number,
    ancestorHidden: boolean,
    clipChain: readonly ClipScope[],
    offX: number,
    offY: number,
    parentDrawTy: number,
    spreadCtx: SpreadCtx | null,
    vsIn: Affine | null,
    // …and the same product with every HOVERTIP stamp left OUT — what the HIT entries are built from. Identical
    // to `vsIn` (the same object) everywhere outside a tooltip subtree, which is everywhere but a few nodes.
    vsHitIn: Affine | null,
    inCardReward: boolean,
    // IS THIS NODE DRAWN SOMEWHERE ITS STREAMED POSE DOES NOT SAY? True for a node carrying a transform override
    // and for EVERY DESCENDANT of one, because a descendant composes through the moved ancestor (`parentFinal`)
    // while its own `gGame` still reads the pose the wire last sent. See the rebase call below for why the flag
    // has to reach them: a tween targets a zero-size holder, and it is the holder's painted children that carry
    // the field claims the picture is made of.
    parentDrawnMoved: boolean,
    // …and the same question for the IDLE LOOP, which moves a node without the claim being allowed to follow. Only
    // the audit reads it, to tell an expected divergence from a defect.
    parentAnimMoved: boolean
  ): void => {
    const wireNode = nodes.get(id);
    if (!wireNode || (skipRoots !== null && skipRoots.has(id))) {
      return;
    }
    // R6 — the animating glyph's own frame, if this node has one. A shallow clone that differs only in its
    // texture fields, so every other answer below is the wire node's.
    const node = frameSubstitutes === null ? wireNode : (frameSubstitutes.get(id) ?? wireNode);
    // GLOBAL — see the header. `gGame` is the TRUE 1920-space global the wire's coordinates live in; `gFinal` is
    // where it is DRAWN. The two diverge whenever a tween override, a cosmetic offset or the wide-screen spread is
    // in force.
    //
    // THE ONE SUBSTITUTION THAT REACHES `gGame` (R8): a map-quill stroke's local is the DrawViewport fit and never
    // legitimately changes, so it is LATCHED (see `PinnedLocalSource`). This is a correction to what the wire
    // said rather than a cosmetic override, which is why it goes in here — ahead of the split — instead of
    // through `transformOverrides`. The guard is the DOM twin's, in its order: only a node that carries stroke
    // geometry can reach `isMapStrokeNode` at all, so every other node in the scene pays one hot property read.
    const wire = node.transform;
    const own =
      pinnedLocals !== null && wire != null && node.linePoints != null && isMapStrokeNode(node)
        ? pinnedLocals.pin(id, wire as Affine)
        : wire;
    const gGame: Affine = own == null ? parentGame : affineMul(parentGame, own as Affine);
    const override = transformOverrides?.get(id) ?? null;
    // THE IDLE LOOP (R4), and the whole of its composition law. `pre` is a PARENT-space translate applied ahead
    // of the node's own wire matrix (the intent bob, which the game runs on the holder so its subtree rides it);
    // `post` is a node-LOCAL conjugation applied after the composition (the orb spin, the map pulse — a rotation
    // or a uniform scale about the node's own pivot, which is what stops it orbiting). Neither reaches `gGame`
    // above: a tap sends the pose the game believes in, and the game believes the loop is pinned at rest.
    const anim = localAnims === null ? null : (localAnims.get(id) ?? null);
    // The node's own rendered global, WITHOUT its spread shift and WITHOUT the inherited cosmetic offset. This is
    // what descendants compose against — and it has to be the UNSHIFTED one, because each node claims its OWN
    // ABSOLUTE `dx` off the squeeze field: composing children against a shifted parent would add the parent's
    // claim to the child's and spread the scene twice. (The DOM walk divides the parent's shift back out through
    // its nested-element inverse; a flat list simply never puts it in.)
    //
    // The `post` half lands AFTER the override, deliberately: a tween sample is an absolute rendered global, and a
    // loop decorates whatever pose the node is drawn at — which is exactly what the DOM's CSS animation does over
    // a baked matrix. Children compose against this, so a spinning group spins its subtree, as the game's does.
    // All of that is `composeLocalAnimGlobal`, shared with the patcher so the two cannot drift.
    const gRaw: Affine =
      anim === null
        ? override != null
          ? (override as Affine)
          : own == null
            ? parentFinal
            : affineMul(parentFinal, own as Affine)
        : composeLocalAnimGlobal(parentFinal, own, override, anim.pre, anim.post);

    // …and whether that rendered global is somewhere the WIRE does not say it is. An override says so for this node
    // and, by composition, for its whole subtree. A local anim deliberately does NOT set it: the idle loop is a
    // cosmetic decoration the game believes is pinned at rest, and a field claim must not become a function of one
    // (`listPatch`'s tier-3 transform arm reasons about exactly that, and refuses a widened stage outright).
    const drawnMoved = parentDrawnMoved || override != null;
    const animMoved = parentAnimMoved || anim !== null;

    // WIDE-SCREEN SPREAD — where this node lands on the squeeze field, and what its children inherit. Evaluated at
    // `gGame` (the node's TRUE pose), exactly as the DOM walk evaluates it at its own `gNode`.
    let spreadDx = 0;
    let spreadWidth = 0;
    let spreadProp = false;
    let childSpread: SpreadCtx | null = null;
    if (spreadCtx !== null && spreadEnv !== null && spreadScratch !== null) {
      const spreadBox = spreadDrawBox(node);
      computeSpread(id, node, spreadCtx, gGame, spreadBox, spreadFactor, spreadEnv, spreadScratch);
      // …and, for a node something is ANIMATING, at the pose it is actually DRAWN at (R6 M2). The walk above
      // measures the field at `gGame` because that is where the GAME has the node; an override says where the
      // client is drawing it this frame, and a field claim is a function of the claimer's own rendered X. Only
      // the two field modes move — see `applyDrawnFieldRebase` for why a rider must not.
      //
      // WHAT SEES THE CORRECTED CLAIM, deliberately: this node's `gSpread` (so the card is DRAWN where it flies)
      // and therefore its paint, its view-scale stamp, its `capturedGlobals` bank (Y-only consumers) and its
      // `mFinal`; the hit entry's `spreadDx`/`renderedWidth` (the input inverse must invert the pose on screen);
      // the `spreadDxOut` bank, whence next build's `ownerDx` and the comet's head sample — so the trail stays
      // glued to the corrected card, one build late exactly as it is today.
      //
      // WHAT DOES NOT, and must not: `gGame`. A tap is answered in true 1920-space at every viewport and through
      // every animation, which is the invariant the hit-grid gate holds this to.
      //
      // IT IS THE WHOLE MOVED SUBTREE, not just the node the override is on — and getting that wrong is what the
      // Aug-29 landing defect was. A hand tween targets the HOLDER, a zero-size positioner that paints nothing;
      // the pixels belong to its descendants, which compose position through the moved holder (`gRaw` carries the
      // move) while claiming the field at their own `gGame` — which the producer FREEZES for the window's whole
      // length. So the card was drawn `travel · (F − 1)` off and snapped when the settle delta thawed `gGame`.
      // Measured at 8.0 / 15.7 / 23.8 design px for a three-card focus at F = 1.3125.
      //
      // `gRaw` rather than `override`: it IS the override for the node carrying one (identical when there is no
      // local anim), and it is the drawn-but-unshifted global for everything below — which is precisely the pose a
      // claim must be evaluated at. Mode-0 riders are unaffected (`applyDrawnFieldRebase` returns early on them)
      // and keep taking the ancestor's already-corrected `childRideDx`.
      if (spreadRebase && drawnMoved) {
        applyDrawnFieldRebase(spreadScratch, node, gRaw, spreadBox, spreadFactor);
      }
      spreadDx = spreadScratch.dx;
      spreadWidth = spreadScratch.renderWidthOverride;
      spreadProp = spreadScratch.spreadMode;
      if (spreadAudit !== null) {
        // Read here, off the scratch's final values and BEFORE `takeSpreadCtx` hands them on — the audit's whole
        // claim is about what this node was drawn with, so it must not be re-derived from anything downstream.
        auditSpreadClaim(
          spreadAudit,
          id,
          node,
          spreadScratch.fieldMode,
          spreadDx,
          gGame,
          gRaw,
          spreadBox,
          spreadFactor,
          drawnMoved,
          animMoved
        );
      }
      // POOLED, and released at the very bottom of this frame — see `takeSpreadCtx` for why that is sound.
      childSpread = takeSpreadCtx(gGame, spreadChildParentWidth(node, spreadCtx.parentWidth), spreadScratch);
      if (spreadDxOut) {
        spreadDxOut.set(id, spreadDx);
      }
      if (spreadFieldModeOut) {
        spreadFieldModeOut.set(id, spreadScratch.fieldMode);
      }
    }
    // The node's own DRAWN placement: its rendered global shifted onto the field. X only — the spread is entirely
    // horizontal, which is the whole reason the raise needs its own vertical inverse (raiseInverse.ts).
    const gSpread: Affine =
      spreadDx === 0 ? gRaw : [gRaw[0], gRaw[1], gRaw[2], gRaw[3], gRaw[4] + spreadDx, gRaw[5]];

    // COSMETIC OFFSET — this node's own, plus everything inherited from its ancestors. Applied to the DRAWN
    // origin only, and never to `gGame`. Resolved HERE, above the view-scale block, because it is an input to it
    // (see the stamp's measured box below) as well as to `gFinal`.
    //
    // IT IS BANKED IN DESIGN SPACE AT ITS OWNER, and that is the correction R7's settle step found. The DOM twin
    // is the individual CSS `translate` property on the OWNER's element, which nesting then carries down: a
    // descendant inherits the owner's translate through the owner's own transform, so stamps applied BELOW the
    // owner cannot scale it. Multiplying every descendant's inherited offset by ITS OWN accumulated stamp — which
    // is what this did — moved a travelable map point's icon by `offset x 1.5` while the map moved by `offset`,
    // so the icons drifted 50% of every scroll and snapped back when a delta landed. That is the user's "map
    // icons are not client-side scrolled; they lag behind", measured at 30 of the map's quads.
    //
    // The case the old spelling was written for still holds, because the owner's OWN factor is applied at the
    // owner: a held card lifted inside a card-reward group that scales 1.25x still rides that group's factor,
    // while the card's own stamp does not stretch its own lift.
    // …AND IT IS EXPRESSED IN THE OWNER'S PARENT SPACE, which is the second half of the same DOM twin. CSS applies
    // the individual `translate` property BEFORE the element's own `transform`, so the vector rides every ancestor
    // transform and none of the owner's own — i.e. it is a translation in the PARENT's basis, not in screen px.
    // Mapping it through `parentFinal`'s linear part is that rule, exactly:
    //
    //     (a c)   (dx)          a·dx + c·dy          the identity chain every recorded frame has ⇒ (dx, dy),
    //     (b d) · (dy)     =    b·dx + d·dy          i.e. byte-for-byte what this line did before.
    //
    // The RAISE is what makes this matter: its dy is measured in CREATURE-LOCAL px (a reticle top, a power row's
    // height — see `raise/creatureHud`), so a creature chain that is not the identity draws the DOM's shift and
    // this one's at different heights, which is U3b's mechanism (1).
    const ownOffset = cosmeticOffsets?.get(id) ?? null;
    const kIn = vsIn === null ? 1 : vsIn[0];
    const ownDx = ownOffset ? parentFinal[0] * ownOffset.dx + parentFinal[2] * ownOffset.dy : 0;
    const ownDy = ownOffset ? parentFinal[1] * ownOffset.dx + parentFinal[3] * ownOffset.dy : 0;
    const drawOffX = ownOffset ? offX + ownDx * kIn : offX;
    const drawOffY = ownOffset ? offY + ownDy * kIn : offY;

    // VIEW SCALE — is this node an enlarged item, and what does its subtree inherit? Measured AT `gSpread`,
    // which is where the node is actually drawn this frame (tween override + spread shift included). The DOM
    // pass has to substitute a tween ENDPOINT for a group instead (`?viewScaleTweenStamp`), because its stamp is
    // prepended onto an element whose base transform the pin already holds AT the endpoint; here there is no pin
    // and no base — the walk re-measures every frame, so measuring where it paints is the same rule, and the two
    // converge exactly at settle.
    let vsSelf = vsIn;
    let vsHitSelf = vsHitIn;
    let childInCardReward = inCardReward;
    if (viewScaling && viewScaleEnv !== null) {
      const leaf = nodeTypeLeaf(node.nodeType);
      childInCardReward = inCardReward || opensCardRewardScreen(leaf);
      const entry = resolveViewScaleForNode(id, node, leaf, inCardReward, viewScaleEnv);
      if (entry !== null && node.localRect != null) {
        if (trackingLocalAnims) {
          // BEFORE the stamp is measured, so a node that would GAIN one by moving is in the set too — see
          // `viewScaleCandidates`.
          viewScaleCandidates.add(id);
        }
        let box = designAabbOf(gSpread, node.localRect);
        // A card-reward `NCard` streams a 0x0 box (its art lives in descendants) — measure the nominal card.
        if ((box.w <= 0 || box.h <= 0) && !entry.isGroup) {
          box = viewScaleNominalBox(gSpread[4], gSpread[5]);
        }
        // R7 — MEASURE WHERE THE NODE IS DRAWN, not where the wire last put it.
        //
        // `gSpread` is the pre-offset pose, so a node a client-side scroll has moved is measured at a stale
        // place: `computeViewScaleStamp` answers NULL for a box fully outside the design stage, so a map point
        // SCROLLED INTO VIEW keeps scale 1 until a wire delta lands, and the anchored clamp re-derives from the
        // un-scrolled box on every build. Both are the same staleness.
        //
        // The algebra is exact rather than approximate, and the pivot is why. Measuring at the shifted box gives
        // a stamp about `p + d`; this walk applies the stamp to the UNSHIFTED pose and adds `d` afterwards, and
        // `T(d)·S(p) === S(p+d)·T(d)` — so subtracting `d` back out of the pivot makes the two compositions the
        // same affine. The clamp offset is a translation and commutes, so it is untouched, and the published
        // `box` stays UNSHIFTED because the input registry's contract is game-space rects (the pointer inverse
        // compensates for the offset before it ever asks).
        const shiftX = drawOffX;
        const shiftY = drawOffY;
        const measured =
          shiftX === 0 && shiftY === 0 ? box : { x: box.x + shiftX, y: box.y + shiftY, w: box.w, h: box.h };
        const res = computeViewScaleStamp(measured, entry, viewScaleDesignW);
        if (res !== null) {
          if (measured !== box) {
            res.pivotX -= shiftX;
            res.pivotY -= shiftY;
          }
          viewScaleStamps.set(id, {
            pivotX: res.pivotX,
            pivotY: res.pivotY,
            k: entry.scale,
            offsetX: res.offsetX,
            offsetY: res.offsetY,
            box,
            spreadDx,
            isGroup: entry.isGroup
          });
          const stamp = viewScaleStampMatrix(entry.scale, res);
          vsSelf = vsIn === null ? stamp : affineMul(vsIn, stamp);
          // The VIEW scale reaches the hit entries too — unchanged behaviour, and deliberate: the enlarged widget
          // is the thing a finger is aiming at. Only the tip stamp below is paint-only.
          vsHitSelf = vsHitIn === null ? stamp : affineMul(vsHitIn, stamp);
        }
      }
    }

    // HOVERTIP SCALE — the tip set's 1.2x enlargement, folded into the SAME product for the same reason: the DOM
    // stage prepends it to the tip root's element and CSS nesting carries it down, so here it has to left-multiply
    // the whole subtree's drawn poses. Composed INSIDE any enclosing view-scale stamp (`vsSelf ∘ tip`), which is
    // what the DOM's element nesting does when a tooltip renders inside an enlarged card-reward group.
    //
    // Measured BEFORE the descent, because the stamp is a function of the children's boxes and it has to be known
    // by the time they are drawn — see `measureTipChildBox`. The measure is thrown away immediately: this map is
    // scratch for the one `computeTipScaleStamp` call below, not a per-build index anyone else reads.
    //
    // NOT PUBLISHED to `viewScaleStamps`. That map is the GAME-space INPUT registry's source, and a tooltip is
    // not a tap target on either stage (the DOM pass publishes nothing either).
    //
    // AND NOT IN THE HIT ENTRIES EITHER — `vsHitSelf` below is why, and it is a measured correction rather than a
    // precaution. This backend hit-tests against the DRAWN pose (`hitStack` tests `mFinal`), so a stamp folded
    // into `gFinal` moves the touch surfaces with the pixels. That is the canvas's standing behaviour for the
    // VIEW scale, where the enlarged item is the tap target. A tooltip is not: it is a decoration the DOM
    // deliberately leaves at its streamed box for input, and its subtree's non-echo descendants DO carry hit
    // entries (the echo exclusion keys on a node's OWN `HoverTip*` leaf, so an inner `NinePatchRect` is a hit
    // surface). Scaling those moved six hit-grid samples at the bottom-right of `wscrisp-hovertip` from
    // `blocked` to not-blocked, against a DOM arm that still blocked them. So the tip stamp reaches the paint and
    // nothing else.
    if (tipScaling && tipLayoutEnv !== null && nodeTypeLeaf(node.nodeType) === TOOLTIP_TYPE) {
      const tipKids = order.childrenOf(id);
      if (tipKids.length > 0) {
        tipChildBoxes.clear();
        for (const cid of tipKids) {
          const box = measureTipChildBox(cid, gGame, gRaw, childSpread, drawnMoved);
          if (box !== null) {
            tipChildBoxes.set(cid, box);
          }
        }
        const tipStamp = computeTipScaleStamp(id, tipLayoutEnv);
        tipChildBoxes.clear();
        if (tipStamp !== null) {
          vsSelf = vsSelf === null ? tipStamp.matrix : affineMul(vsSelf, tipStamp.matrix);
          if (trackingLocalAnims) {
            // The `viewScale` refusal, reused: a stamped tip is a node whose drawn pose carries a factor the
            // tier-3 patcher does not model, and its span must rebuild rather than be re-posed numerically.
            viewScaleCandidates.add(id);
          }
        }
      }
    }

    // The accumulated stamp product LEFT-multiplies this node's drawn pose — see the header. Children recurse
    // with `vsSelf` and with `gGame`/`gRaw` UNCHANGED, so the product cascades exactly like CSS nesting does.
    const gScaled: Affine = vsSelf === null ? gSpread : affineMul(vsSelf, gSpread);
    // …and the same composition minus the tip stamps, for the hit entry. `vsHitSelf === vsSelf` is the common
    // case (the same object), and then this is the same matrix rather than a second multiply.
    const gHitScaled: Affine =
      vsHitSelf === vsSelf ? gScaled : vsHitSelf === null ? gSpread : affineMul(vsHitSelf, gSpread);

    const gFinal: Affine =
      drawOffX === 0 && drawOffY === 0
        ? gScaled
        : [gScaled[0], gScaled[1], gScaled[2], gScaled[3], gScaled[4] + drawOffX, gScaled[5] + drawOffY];
    const gHitFinal: Affine =
      gHitScaled === gScaled
        ? gFinal
        : drawOffX === 0 && drawOffY === 0
          ? gHitScaled
          : [
              gHitScaled[0],
              gHitScaled[1],
              gHitScaled[2],
              gHitScaled[3],
              gHitScaled[4] + drawOffX,
              gHitScaled[5] + drawOffY
            ];

    // R7 W3-T — HAND THE PATCHER THIS NODE'S FOUR MATRICES. See {@link LocalAnimFrame} for what each is for.
    //
    // OMITTED WHEN AN OVERRIDE IS IN FORCE, and that omission is load-bearing: with `override != null` the node's
    // `gRaw` is an absolute tween pose that ignores `pre` entirely, so `base`/`wire` no longer reconstruct it and
    // a patcher recomputing from them would place the node somewhere the walk never would. Absent is exactly the
    // right answer — the patcher's `unknownAnim` refusal reads a missing entry as "rebuild".
    if (trackingLocalAnims && anim !== null && override == null) {
      localAnimFrames.set(id, {
        drawn: gFinal,
        // `T(off) · vsSelf`, inline: a left translation only adds into the translation column.
        outer:
          vsSelf === null
            ? [1, 0, 0, 1, drawOffX, drawOffY]
            : [vsSelf[0], vsSelf[1], vsSelf[2], vsSelf[3], vsSelf[4] + drawOffX, vsSelf[5] + drawOffY],
        base: parentFinal,
        wire: own ?? null,
        spreadDx,
        // The rebase is what makes a field claim a function of the DRAWN pose, and a local anim moves the drawn
        // pose. `drawnMoved` is false for the anim itself (deliberately — see above), so this is only ever true
        // under an ANCESTOR's transform override, which is exactly the case the patcher has to give up on.
        spreadRebased: spreadRebase && drawnMoved
      });
    }

    // The captured global is the node's DRAWN placement including its spread shift — the DOM twin reads the baked
    // `matrix()` off the element, which carries the same shift. Its consumers (`scrollRenderedY`, the held-card
    // lift) are Y-only, so at 16:9 this is the same value it always was.
    const orphan = node.parentId != null && !nodes.has(node.parentId);
    const hidden = ancestorHidden || node.visible === false || orphan;
    const alphaOverride = alphaOverrides?.get(id) ?? null;
    // Through the exported helper, so the patcher's copy of this rule IS this rule (see `streamedAlphasOf`).
    streamedAlphasOf(node, streamedScratch);
    const modAlpha = alphaOverride?.mod ?? streamedScratch.mod;
    const selfAlpha = alphaOverride?.self ?? streamedScratch.self;
    const cascadeOpacity = cascadeAlpha * modAlpha;
    const ownOpacity = cascadeOpacity * selfAlpha;
    const modRgb = rgbOf(node.modulate);
    const childR = tintR * modRgb.r;
    const childG = tintG * modRgb.g;
    const childB = tintB * modRgb.b;
    const selfRgb = rgbOf(node.selfModulate);
    const ownR = childR * selfRgb.r;
    const ownG = childG * selfRgb.g;
    const ownB = childB * selfRgb.b;

    // The spread's own anchored-span widening wins where it applies; the option map is the caller's escape hatch.
    const renderWidthOverride = spreadWidth !== 0 ? spreadWidth : renderWidthOverrides?.get(id);
    const input: NodePaintInput = {
      node,
      global: gFinal,
      ownOpacity,
      tintR: ownR,
      tintG: ownG,
      tintB: ownB,
      hidden,
      order: order.orderOf(id),
      renderWidthOverride,
      clipAxisOutsetX: clipAxisOutsetFor(node, nodes),
      nodes
    };
    nodePaintInputs.set(id, input);
    if (capture !== null && capture.ids.has(id)) {
      capture.out.set(id, { g: gSpread, parentTy: parentDrawTy, drawn: gFinal, modulate: [ownR, ownG, ownB, ownOpacity] });
    }

    // CLIP — opened before the whole subtree (behind children included: they are inside the clipper's box in the
    // DOM too) and closed after it. Skipped entirely for a hidden subtree, which paints nothing to clip; that
    // keeps push/pop balanced on one boolean rather than on two independently-evaluated conditions.
    const clip = hidden ? null : nodeClipSpec(input);
    let childChain = clipChain;
    let clipPushIndex = -1;
    if (clip) {
      clipPushIndex = list.pushClipRect(clip);
      stats.clips++;
      const scope: ClipScope = { id, spec: clip };
      childChain = clipChain === NO_CLIP_SCOPES ? [scope] : clipChain.concat(scope);
    }

    const kids = order.childrenOf(id);
    const behind = order.behindCountOf(id);
    for (let i = 0; i < behind; i++) {
      walk(kids[i], gGame, gRaw, cascadeOpacity, childR, childG, childB, hidden, childChain, drawOffX, drawOffY, gFinal[5], childSpread, vsSelf, vsHitSelf, childInCardReward, drawnMoved, animMoved);
    }

    // SELF. `paintStart` is taken HERE, after the behind children: the range must be the node's own commands and
    // nothing else, or a parent's range would swallow its behind subtree and stop being splice-able.
    const paintStart = list.count;
    const cls: NodeClass = classifyNode(node, ownOpacity, hidden);
    if (cls === "canvas") {
      stats.canvas++;
      if (emitNodePaint(input, scratch, sink, emitOptions) === 0) {
        stats.silent++;
      } else {
        if (
          input.order > backstopOrder &&
          isStageBackstop(node, ownOpacity, gFinal, backstopDesignW, renderWidthOverride)
        ) {
          backstopOrder = input.order;
          // …AND THE FILL ITSELF, which is what decides whether a covered surface can be DIMMED instead of
          // dropped. The walk is the only place both factors exist at once, and `isStageBackstop` collapses them
          // to a boolean — so they are taken here rather than re-derived by a consumer that has neither.
          const fill = node.fillColor!;
          backstopAlpha = Math.min(1, Math.max(0, ownOpacity * fill.a));
          backstopBlack = fill.r <= BACKSTOP_BLACK_EPS && fill.g <= BACKSTOP_BLACK_EPS && fill.b <= BACKSTOP_BLACK_EPS;
        }
        // The cover pass's input: what this node actually painted, in paint order. A `silent` node contributed no
        // command, so it covers nothing and is deliberately not banked.
        coverGrow();
        if (placedBoxAabbInto(input, coverBoxes, coverCount * 4)) {
          coverOrders[coverCount] = input.order;
          coverCount++;
        }
      }
    } else if (cls === "overlay") {
      stats.overlay++;
      // THE ENCLOSING CHAIN, not `childChain`: a node's own clip scope crops its own ink, which is the direction
      // that loses a label's outline (see `intersectOverlayClip`). This is the same chain `buildHitEntry` below
      // is handed for this node, so paint and touch crop on one rule.
      const record = overlayRecordFor(input, clipChain);
      if (record) {
        overlayRecords.push(record);
        overlayByKind[record.kind]++;
        if (trackingLocalAnims && clipChain.length > 0) {
          // See `overlayClipped`: this record's crop is a function of WHERE its box lands inside the enclosing
          // intersection, so moving it can add or remove a crop the patcher has no way to recompute.
          overlayClipped.add(id);
        }
        // M2 — the effect surface's own pixels, RIGHT HERE, at the node's paint index. Emitting from inside the
        // walk is what makes the quad free of every problem the DOM overlay has with depth: it lands between the
        // commands the game paints before and after this node, inside whatever clip scopes are open, and inside
        // the node's own `NodeCommandRange` for the tier-3 patcher — none of which needed a line of new plumbing.
        //
        // NOT banked into the cover pass. `coverBoxes` feeds `OverlayRecord.coveredAbove`, whose only consumer is
        // the HOIST RULE — which is inert for exactly these kinds once the flag is on (and which M2's follow-up
        // retires outright). Banking them would change `coveredAbove` for the OTHER records under the flag and
        // for nothing else, i.e. it would move a number no one reads.
        if (stageOwnedNoop?.(input, record) === true) {
          stageOwnedNoopIds.add(record.id);
        } else if (fxSource !== null && FX_QUAD_KINDS.has(record.kind)) {
          const screen = fxSource.emitScreen?.(input, record) ?? 0;
          if (screen === "pending") {
            // Strict admission owns the pending semantic record and prevents
            // presentation; never substitute a DOM effect host.
          } else if (screen > 0 || emitFxQuad(input, record, scratch, sink, fxSource) > 0) {
            stats.fxQuads++;
            fxQuadIds.add(record.id);
          }
        }
        // …and the SPINE twin (A2), SELECTIVE. A still is worth its VRAM only where the hoisted `<img>` is
        // actually wrong — where the game paints over the creature — so `wanted` gates on the PREVIOUS build's
        // cover answer (see `SpineQuadSource`). Every "no" on this path falls back to today's hoist, which is why
        // there is no state in which a creature disappears.
        //
        // Multi-frame clips are NOT reachable here at all: `overlay.spineQuads()` publishes only committed
        // single-frame stills, so `boxFor` answers null for an animating creature and it keeps its canvas.
        if (spineSource !== null && record.kind === "spine" && spineSource.wanted(record.id)) {
          const meshes = node === undefined ? 0 : spineSource.emitMeshes?.(record, node) ?? 0;
          if (meshes === "pending") {
            // A strict source owns the upcoming frame but must not present a
            // partial raster/DOM substitute while it is loading.
          } else if (meshes > 0) {
            stats.spineQuads += meshes;
            spineQuadIds.add(record.id);
          } else {
            const box = spineSource.boxFor(record.id);
            if (box !== null && spineSource.admit(record.id) && emitSpineQuad(record, box, node, scratch, sink) > 0) {
            stats.spineQuads++;
            spineQuadIds.add(record.id);
            }
          }
        }
        // …and the CARD TRAIL (A4). Unlike the two above, this surface has no other way to reach the screen on
        // this backend at all: the overlay has never had an element for a trail, so before this the comet simply
        // was not drawn. The strip is the client's own integration of the card's motion (`cardTrailState`), and
        // emitting it HERE is what puts it under everything the game paints over a flying card.
        if (trailSource !== null && record.kind === "trail") {
          const pushed = emitTrailQuads(input, record, scratch, sink, trailSource);
          if (pushed > 0) {
            stats.trailQuads += pushed;
            trailQuadIds.add(record.id);
          }
        }
        // …and the LABEL (M4). `boxFor` resolves the spec, lays the text out and rasters it, all inside this
        // build — the same "uploading happens where a budget can see it" rule the other three registries take.
        // Every null is safe by the same argument the spine branch makes: no quad means the DOM overlay keeps its
        // element and the label renders exactly as it does today.
        if (record.kind === "text") {
          // THE GLYPH PATH FIRST, WHEN THERE IS ONE, and only then the raster — see `glyphSource` for why the
          // two are exclusive per label (drawing both is double ink at a half-pixel offset, which reads as a
          // bolder, blurrier label rather than as a bug). `runs === 0` is every one of the glyph path's five
          // refusals plus "the pass drew nothing", and it falls straight through to the raster below.
          let runs = 0;
          let richPending = false;
          if (glyphSource?.emitRich !== undefined && node !== undefined && node.richText) {
            const emitted = glyphSource.emitRich(input, record, scratch, sink);
            if (emitted === "pending") {
              richPending = true;
            } else {
              runs = emitted;
            }
          } else if (glyphSource !== null) {
            const block = glyphSource.blockFor(record);
            if (block === "pending") {
              richPending = true;
            } else if (block !== null) {
              runs = emitTextGlyphs(record, block, scratch, sink, glyphFloor);
            }
          }
          if (runs > 0) {
            stats.textGlyphLabels++;
            stats.textGlyphRuns += runs;
            // The SAME id set the raster path publishes. Its consumers ask "did the canvas draw this label", not
            // "how" — the overlay drops its element on either answer, and a label drawn as outlines that kept a
            // hoisted element would render twice.
            textQuadIds.add(record.id);
          } else if (!richPending && textSource !== null) {
            const box = textSource.boxFor(record);
            if (box !== null && emitTextQuad(record, box, node, scratch, sink, textSnap) > 0) {
              stats.textQuads++;
              textQuadIds.add(record.id);
            }
          }
        }
      }
    } else {
      stats.skip++;
    }
    if (!hidden && isCombatPileContainer(node)) {
      handRaiseAnchorId = id;
      if (options.handRaiseChrome) {
        const beforeChrome = list.count;
        options.handRaiseChrome.emit(input, scratch, sink);
        if (list.count > beforeChrome) handRaiseChromeCommand = beforeChrome;
      }
    }
    if (onNode) {
      onNode(id, cls);
    }
    const paintEnd = list.count;
    if (paintEnd > paintStart) {
      ranges.set(id, { start: paintStart, paintEnd });
    }

    if (wantHits && isHitSurfaceCandidate(node)) {
      const entry = buildHitEntry({
        node,
        nodes,
        memo: hitMemo,
        order: input.order,
        // The DRAWN pose MINUS any hover-tip stamp — see the tip block for the six samples that says. Identical
        // to `gFinal` for every node outside a tooltip subtree.
        mFinal: gHitFinal,
        mGame: gGame,
        clipScopeChain: clipChain,
        paints: cls !== "skip",
        hidden,
        spreadDx,
        renderedWidth: spreadWidth,
        spreadProp
      });
      if (entry) {
        hitEntries.push(entry);
      }
    }

    for (let i = behind; i < kids.length; i++) {
      walk(kids[i], gGame, gRaw, cascadeOpacity, childR, childG, childB, hidden, childChain, drawOffX, drawOffY, gFinal[5], childSpread, vsSelf, vsHitSelf, childInCardReward, drawnMoved, animMoved);
    }

    if (clip) {
      const pop = list.popClip();
      clipRanges.set(id, { push: clipPushIndex, pop });
    }
    if (childSpread !== null) {
      // AFTER both child loops, which are this context's only readers. Paired with the `takeSpreadCtx` above on
      // every path out of this frame, so the pool's cursor is always the walk's current depth.
      spreadDepth--;
    }
  };

  for (const id of order.rootIds) {
    walk(
      id,
      IDENTITY_AFFINE,
      IDENTITY_AFFINE,
      1,
      IDENTITY_TINT.r,
      IDENTITY_TINT.g,
      IDENTITY_TINT.b,
      false,
      NO_CLIP_SCOPES,
      0,
      0,
      0,
      spreadRoot,
      null,
      null,
      false,
      false,
      false
    );
  }

  markCoveredOverlays(overlayRecords, spineSource);

  stats.commands = list.count;
  stats.textures = textures.size;
  stats.hitEntries = hitEntries.length;
  stats.maxClipDepth = list.maxClipDepth;

  if (assert && list.clipDepth !== 0) {
    throw new Error(`[buildDrawList] unbalanced clip stack: ${list.clipDepth} scope(s) left open`);
  }

  return {
    order,
    overlayRecords,
    hitEntries,
    ranges,
    nodePaintInputs,
    clipRanges,
    handRaiseChromeCommand,
    handRaiseAnchorId,
    fxQuadIds,
    stageOwnedNoopIds,
    spineQuadIds,
    trailQuadIds,
    textQuadIds,
    viewScaleStamps,
    backstopOrder,
    backstopAlpha,
    backstopBlack,
    localAnimFrames,
    viewScaleCandidates,
    overlayClipped,
    stats
  };
}

/**
 * Is this node's own paint a STAGE-SPANNING OPAQUE FILL — the thing a dialog puts between the game and itself?
 *
 * `mirrorRenderer.coverAbove`'s predicate, with two of its steps already done by the walk: the composed alpha is
 * `ownOpacity` (that function recomputes it up the ancestor chain) and the pose is the DRAWN one. `deckview`
 * carries ten of these at `#000000d9`, which is why the threshold is 0.7 rather than 1 — the game dims what is
 * behind a sheet rather than replacing it, and the mirror must read that as a cover all the same.
 *
 * `renderW` IS THE WIDTH THE SHEET IS PAINTED AT, which on a widened stage is not `localRect.width`. A dialog's
 * backdrop is a 0/1-anchored Control, so the spread's anchor algebra STRETCHES it — 1920 authored, 2520 drawn at
 * F = 1.3125 — and every one of the three consumers that puts pixels on screen (`emitNodePaint`, the cover pass's
 * box, the overlay clip) reads `renderWidthOverride`. This test read the authored number instead, decided a sheet
 * covering the whole stage covered 1920 of 2520, and answered -1: no backstop at all, at exactly the viewport
 * where the user reported combat labels painting over a dialog.
 *
 * WHAT MUST STAY REFUSED, and it is the reason this is a parameter rather than a `× spreadFactor`. A 0/0-anchored
 * sheet that already fills its frame takes the RE-CENTRING branch (`spreadLayout`'s `fullCanvas`): it is shifted
 * by half the widening and NOT widened, so at 2520 it genuinely covers [300, 2220] and leaves 300 px of game
 * visible down each side. Reading the spread off the factor would call that a cover; reading it off the width the
 * sheet is actually drawn at correctly does not — and a false positive here HIDES dialog text, which is a worse
 * failure than the one being fixed.
 */
function isStageBackstop(
  node: MirrorNode,
  ownOpacity: number,
  g: Affine,
  designW: number,
  renderW: number | undefined
): boolean {
  const lr = node.localRect;
  if (!node.fillColor || node.shaderId != null || !lr) {
    return false;
  }
  if (ownOpacity * node.fillColor.a < BACKSTOP_COVER_MIN_ALPHA) {
    return false;
  }
  if (Math.abs(g[1]) > 1e-4 || Math.abs(g[2]) > 1e-4 || g[0] <= 0 || g[3] <= 0) {
    return false; // rotated / skewed / mirrored: not a stage-spanning rectangle
  }
  // `placedBoxAabbInto`'s rule, two lines below at the call site — one width answer for paint, cover and this.
  const width = renderW !== undefined && renderW > 0 ? renderW : lr.width;
  const x0 = g[4] + g[0] * lr.x;
  const y0 = g[5] + g[3] * lr.y;
  return (
    x0 <= COVER_EDGE_EPS &&
    y0 <= COVER_EDGE_EPS &&
    x0 + width * g[0] >= designW - COVER_EDGE_EPS &&
    y0 + lr.height * g[3] >= MIRROR_DESIGN_HEIGHT - COVER_EDGE_EPS
  );
}

/** `mirrorRenderer.BACKSTOP_COVER_MIN_ALPHA` / `COVER_EDGE_EPS`, restated for the reason `isStageBackstop` is. */
const BACKSTOP_COVER_MIN_ALPHA = 0.7;
const COVER_EDGE_EPS = 1;
/**
 * How close to black a sheet's fill must be for a covered surface to be DIMMED rather than dropped.
 *
 * The compositing behind {@link DrawListBuild.backstopBlack}: the game draws `result = under·(1 − a) + a·C`. CSS
 * `opacity` can express the first term and has no way at all to express the second, so a sheet with any colour in
 * it is not dimmable — it would come out as a faded label with the sheet's own wash missing. A BLACK sheet makes
 * `a·C` zero and the two agree exactly, which is why this is a threshold on the colour and not on the alpha. One
 * 8-bit step is the tolerance: `#000000d9` is the whole measured population.
 */
const BACKSTOP_BLACK_EPS = 1 / 255;

function rgbOf(color: MirrorColor | null): { r: number; g: number; b: number } {
  return color ? color : IDENTITY_TINT;
}

/**
 * The spread environment for one build: the three SCENE-IDENTITY branches (shared verbatim with the DOM walk, so
 * the two stages can never disagree about which nodes re-centre) plus the two REGISTRY answers, which come from
 * the caller's retained state or fall back the way the DOM walk falls back when it cannot resolve them.
 */
function spreadEnvFor(
  nodes: Map<string, MirrorNode>,
  registry: SpreadRegistry | null,
  spreadFactor: number
): SpreadEnv {
  return {
    ...spreadSceneIdentityEnv((id) => resolveSceneInfo(id, nodes)),
    // No registry ⇒ ride the parent, which is what the DOM walk does for a floater whose owner has no record yet.
    ownerDx: (ownerId, fallbackDx) => (registry ? registry.ownerDx(ownerId, fallbackDx) : fallbackDx),
    // …and a follower with nothing resolvable under it takes a POSITIONAL claim at its own game X, which is
    // `hitTestShift`'s own no-painting-anchor fallback.
    remoteFollowerDx: (node, gx, gy) =>
      REMOTE_FOLLOWER_TYPES.has(nodeTypeLeaf(node.nodeType))
        ? registry
          ? registry.followerShift(gx, gy)
          : fieldDxAtOriginX(gx, spreadFactor)
        : null
  };
}

/**
 * The R20 one-axis clip outset for a node's SCENE IDENTITY, or undefined.
 *
 * `mirrorRenderer.clipAxisOutsetFor`'s shape: the cheap node-NAME pre-filter first, so the allocating scene walk
 * only runs for the handful of nodes that could match the table at all.
 *
 * The `clipAxisOn()` test is the DOM's own gate, asked ONE step earlier: that backend applies the outset when it
 * writes the style, while here the number is baked into the paint input, so a switched-off outset has to be
 * refused at the source. The readability-scaling switch controls the same exception in both backends.
 */
function clipAxisOutsetFor(node: MirrorNode, nodes: Map<string, MirrorNode>): number | undefined {
  if (!clipAxisOn() || !node.clipContents || !CLIP_AXIS_CANDIDATE_NAMES.has(node.name)) {
    return undefined;
  }
  const scene = resolveSceneInfo(node.id, nodes);
  return resolveClipAxisOutset(scene?.file ?? null, scene?.relPath ?? null) ?? undefined;
}
