// TIER-3 INCREMENTAL PATCHING — a frame whose only change is ALPHA, written into the list the last build left.
//
// `buildDrawList` rebuilds the whole scene every animated frame (measured p50: 5.3 ms on combat, 8.3 ms on the
// map). Probe P8 says what those frames are actually doing: 124 of the reshuffle's 137 hints are `modulate:a`,
// i.e. a fade, and a fade moves no geometry, no clip, no paint order and no classification — it multiplies four
// floats per quad. This module is the arithmetic that does that instead, against the commands the last build
// already recorded.
//
// WHY OPACITY ONLY, AND WHY A TRANSFORM TIER IS NOT "THE SAME THING WITH A DIFFERENT CHANNEL".
// A node's own paint range is exactly that — its OWN commands. An alpha change stays inside it plus its subtree's
// ranges, because that is precisely how the walk composes alpha: `cascadeOpacity` down the tree, `ownOpacity` at
// the node. A TRANSFORM override changes `gRaw`, which every descendant composes against, AND `hitEntries.mFinal`,
// AND `capturedGlobals`, AND the cover pass's boxes, AND the clip rects, AND the view-scale stamps, AND the
// overlay records' placement. That is a subtree re-emit — tier 2 — wearing tier 3's clothes, and it is not here.
// The `transform` bucket in the bail histogram is how big that job would be, as a number.
//
// THE ARITHMETIC. `paintSpec.setQuadColor` writes `alpha = clamp01(ownOpacity × a_paint)` and
// `rgb = clampChannel(tint × colour) × alpha`. So when a node's `ownOpacity` moves from A to A', every one of its
// quads scales by exactly `k = A'/A` — all four floats, alpha and the premultiplied channels alike, because the
// tint factor is independent of alpha and the paint colour is unchanged. Two things can break that identity, and
// both are refused rather than approximated:
//   * CLAMPING. `clamp01` is not linear at its ends. Any node whose composed alpha exceeds 1 (Godot's modulate is
//     allowed to over-brighten) is out, on either side of the change, and so is any quad whose recorded alpha is
//     larger than the node alpha it was composed from — which is the signature of a paint colour with `a > 1`,
//     the only other way the product can reach the clamp.
//   * A CLASS FLIP. Below `nodeIsPainting`'s threshold a node emits NOTHING, so a fade that crosses it has to add
//     or remove commands — which is a rebuild by definition. The test here calls `nodeIsPainting` itself rather
//     than restating its threshold, so it cannot drift from the walk's own answer.
//
// AND WHY THE MULTIPLY, NOT A RECOMPUTE. Recomputing `ownOpacity × a_paint` would need `a_paint`, which is the
// emitter's business and is not in the list. The ratio needs neither: it is derivable from what the list holds and
// what the overrides now say, which is the whole reason the applied-alpha snapshot exists.
//
// NESTED ACTIVES COMPOSE FOR FREE. A subtree walk carries the applied and the new cascade product side by side, so
// a fade INSIDE a fade is just two ratios multiplying — the inner node's own factor is read from the same two maps
// as everyone else's. What that does require is that a root which is a DESCENDANT of another root is not walked
// twice, or its own factor would be applied twice; `patchOpacity` skips those, it does not bail on them.
//
// VALIDATE, THEN APPLY, AND NEVER HALF OF EITHER. Every refusal above is discovered during a walk that writes
// nothing. A patch that bailed after touching three quads would leave a frame the renderer cannot fix by
// rebuilding — the rebuild is correct, but the pixels between are not, and worse, the applied-alpha snapshot would
// no longer describe the list. So the walk records `(range, k)` triples and the writes happen only once the whole
// plan is known to be legal.
//
// PURE, and deliberately so: no DOM, no GL, no renderer state, no clock. The list arrives as a narrow interface
// (four methods of gsw's `DrawList`), the scene arrives as an `Env` of accessors, and the scratch is caller-owned,
// so a spec drives the whole thing with a fake list and three plain maps.

import type { GlyphsView, NinePatchView, QuadView } from "@godot-scene-web/canvas";

import type { AlphaOverride, NodeCommandRange, StreamedAlphas } from "@/mirror/canvas/buildDrawList";
import { composeLocalAnimGlobal, streamedAlphasOf } from "@/mirror/canvas/buildDrawList";
import { nodeIsPainting, overlayKindOf } from "@/mirror/canvas/paintSpec";
import type { MirrorNode } from "@/mirror/sceneTree";

/**
 * How many patch frames may follow one build before the next frame rebuilds anyway.
 *
 * TWO JOBS, one number. It BOUNDS THE DRIFT: a patch is a float32 multiply, so a chain of them accumulates
 * rounding the rebuild would not have (measured below 2e-6 relative over 30 links, i.e. under half a bit of an
 * 8-bit channel). And it SELF-HEALS: anything this module cannot see — a texture that landed, a repacked page, an
 * overlay style the walk would have rewritten — is corrected within half a second at 60 Hz, whatever else happens.
 */
export const PATCH_CHAIN_MAX = 30;

/** Relative tolerance on "this quad's recorded alpha is consistent with the node alpha it was composed from". */
const CLAMP_EPS = 1e-6;

/**
 * Why a frame rebuilt instead of patching. Every one of these is counted, and the histogram is the deliverable
 * even when the answer is "almost never patches": it is the only measurement that says how much of the frame
 * budget a TIER-2 subtree splice would be able to claim.
 *
 * FRAME-LEVEL (the renderer's own preconditions, checked before this module is called):
 *   `noBuild`       — nothing has been built yet, or the renderer has no state.
 *   `contextLost`   — the GL context is gone; the list is about to be rebuilt from scratch anyway.
 *   `noSamples`     — the sweep animated nothing at all, so this frame was woken by something else entirely.
 *   `staleState`    — THE SCENE MOVED SINCE THE BUILD. The wire applies a delta into the live state as the message
 *                     arrives and schedules its reconcile in a SEPARATE rAF, so an animation frame can land in
 *                     between and see node data the list predates. Today's code rebuilds there (and the reconcile
 *                     rebuilds again moments later); patching a list that is already out of date would be a
 *                     behaviour change rather than a shortcut, so it is refused.
 *   `source`        — a source sample which did not satisfy the deliberately narrow source-patch contract below.
 *   `transform`     — a sample moved a transform (a tween or a card flight). See the header: tier 2, not this.
 *   `offsetPending` — an eager-scroll write is folded and owed a build.
 *   `cosmetic`      — a cosmetic offset changed since the build, which translates a whole subtree.
 *   `trailLatch`    — a card trail PINNED or RELEASED a stroke's pose since the build. A latch writes the same
 *                     override map a tween sample does but raises no sample bit, because it is not a sample; this
 *                     is the counter that makes it visible anyway, instead of leaving it shadowed by `trails`
 *                     (which covers a different fact, and only while the two schedules happen to overlap).
 *   `trails`        — a comet has a live point history; its ribbon geometry is re-integrated per frame.
 *   `fx`            — an effect surface's pixels are newer than its texture, and closing that needs `fx.endBuild`.
 *   `spine`         — a still committed to (or vanished from) an overlay element since the build, so the set of
 *                     nodes that would be quadded has moved. Gated on the overlay's `spineQuadVersion`: a bare
 *                     `spine !== null` test would take every animated frame and stop patching entirely.
 *   `chain`         — the renderer's patch-chain limit was reached.
 * NODE-LEVEL (this module's own walk):
 *   `unknownNode`   — a sampled node is not in the state the list was built from: the structure moved.
 *   `overlay`       — an overlay node is in the subtree. Its pixels are a DOM element or an fx/spine/trail quad
 *                     built from `record.opacity`, and only a build (and the overlay sync behind it) restyles it.
 *   `polyline`      — a stroke is inside the range. Its colour is a polyline payload, not a quad's. NOT text: a
 *                     `glyphs` run has a `patchGlyphsColor`/`patchGlyphsTransform` pair like a quad's, and the
 *                     transform tier takes it (see `THE GLYPH TERM`). The opacity tier never sees one, because a
 *                     label is an overlay node and `overlay` answers first — stated so the dead arm is not
 *                     rediscovered as a missing feature.
 *   `clamp`         — see the header.
 *   `classFlip`     — see the header.
 *   `zeroApplied`   — the node is painting at alpha 0 (or less) in the list, so no ratio can recover from it.
 *                     A GUARD, not an expected outcome: a node at zero was not painting and therefore has no
 *                     range, so `classFlip` answers first for every case that can actually arise (pinned by
 *                     spec). It is here so a future change to the painting predicate cannot turn a refusal into a
 *                     division by zero.
 *
 * THE TRANSFORM TIER's own two frame-level refusals and ten node-level ones (see {@link planTransform}):
 *   `localAnim`     — a local anim moved a pose and the transform tier is not on. THE MEASURING STICK: this
 *                     bucket is exactly the frame count the tier claims when it is.
 *   `spread`        — a widened stage whose field claims RIDE THE DRAWN POSE (`LocalAnimFrame.spreadRebased`), or
 *                     `?spreadPatch=off`. NOT every widened stage: see `THE SPREAD TERM` below for the algebra
 *                     that made the blanket refusal — which cost every maximized desktop browser its idle frames,
 *                     because browser chrome puts a 1920x1080 window at aspect 1.97 — unnecessary.
 *   `unknownAnim`   — a node is animating that the last build published no frame for: it was overridden then, or
 *                     it started animating after the build. Either way the four matrices are absent, which IS
 *                     the refusal.
 *   `nestedRoots`   — a second animated root inside this one's span. Two multipliers, one node.
 *   `viewScale`     — a view-scale candidate in the span: the stamp is measured at the DRAWN box, so moving the
 *                     span can gain or lose one, which is a structural change and not a numeric one.
 *   `clipRect`      — a clipper in the span. Its rect is baked from its own global and gsw has no
 *                     `patchClipRect`. Keyed on the build's `clipRanges`, not on the node kind: a PAINTLESS
 *                     clipper owns commands outside any paint range, and a kind test alone would miss it.
 *   `spanOffset`    — a cosmetic offset BELOW the root. The root's own is inside `outer` and constant; one
 *                     further down adds a term to part of the span only.
 *   `captured`      — a node in the span is in `captureGlobals`. Those are read by the eager-scroll engine and
 *                     the held-card lift, and a captured global is REFUSED rather than left stale.
 *   `backstop`      — the stage backstop paints inside the span. Its order decides what the overlay withholds.
 *   `trailQuad`     — a comet's ribbon is in the span; its cells are re-integrated by a source this cannot see.
 *   `overlayClip`   — an overlay record in the span was cropped against a real clip chain, and the crop is a
 *                     function of where its box lands inside that intersection.
 *   `spanOverride`  — a DESCENDANT carries a transform override. Its pose is absolute, so it does NOT ride the
 *                     root's anim — the one place the "every node draws `C · g`" chain is broken from inside.
 *   `textScale`     — a CANVAS-DRAWN LABEL is in the span and `D`'s linear part is not the identity. See
 *                     `THE GLYPH TERM`: a label's pixels are keyed by SCALE on both text backends, so a scaling
 *                     delta is the one case where a re-pose is not the frame a rebuild would have written.
 */
export type PatchBailReason =
  | "noBuild"
  | "contextLost"
  | "noSamples"
  | "staleState"
  | "source"
  | "sourceShape"
  | "sourceTexture"
  | "transform"
  | "offsetPending"
  | "cosmetic"
  | "localAnim"
  | "spread"
  | "trailLatch"
  | "trails"
  | "fx"
  | "spine"
  | "chain"
  | "unknownNode"
  | "overlay"
  | "polyline"
  | "clamp"
  | "classFlip"
  | "zeroApplied"
  | "unknownAnim"
  | "nestedRoots"
  | "viewScale"
  | "clipRect"
  | "spanOffset"
  | "captured"
  | "backstop"
  | "trailQuad"
  | "overlayClip"
  | "spanOverride"
  | "textScale";

/** Every reason, in histogram order — so a census block has the same keys whether or not any frame hit them. */
export const PATCH_BAIL_REASONS: readonly PatchBailReason[] = [
  "noBuild",
  "contextLost",
  "noSamples",
  "staleState",
  "source",
  "sourceShape",
  "sourceTexture",
  "transform",
  "offsetPending",
  "cosmetic",
  "localAnim",
  "spread",
  "trailLatch",
  "trails",
  "fx",
  "spine",
  "chain",
  "unknownNode",
  "overlay",
  "polyline",
  "clamp",
  "classFlip",
  "zeroApplied",
  "unknownAnim",
  "nestedRoots",
  "viewScale",
  "clipRect",
  "spanOffset",
  "captured",
  "backstop",
  "trailQuad",
  "overlayClip",
  "spanOverride",
  "textScale"
];

/** The scene, as the four questions this module asks about it. Everything is the LAST BUILD's view. */
export interface PatchEnv {
  nodeOf(id: string): MirrorNode | undefined;
  /** The node's children in the build's paint order — the same walk order, so nothing is missed or repeated. */
  childrenOf(id: string): readonly string[];
  /** Where the node's OWN paint landed, or undefined when it pushed nothing. */
  rangeOf(id: string): NodeCommandRange | undefined;
  /** The alpha override the LIST was built from (`null` on a field ⇒ the streamed value stands). */
  appliedAlphaOf(id: string): AlphaOverride | undefined;
  /** The alpha override the next build WOULD use. */
  currentAlphaOf(id: string): AlphaOverride | undefined;
}

/** The list, as the four methods a colour patch needs. Structurally a gsw `DrawList` of any texture type. */
export interface PatchTarget {
  kindNameAt(index: number): string;
  readQuad(index: number, out: QuadView): QuadView;
  readNinePatch(index: number, out: NinePatchView): NinePatchView;
  patchQuadColor(index: number, r: number, g: number, b: number, a: number): void;
}

/**
 * One source substitution that has already been resolved to a live executor texture.
 *
 * Source samples are intentionally not a subtree walk. An intent frame is one emitted atlas quad; accepting a
 * range with another shape would silently leave a sibling paint stale. The renderer resolves the new texture
 * without acquiring it, so `null` means "not resident" and remains a full-build bailout.
 */
export interface SourcePatch<TTexture = unknown> {
  id: string;
  range: NodeCommandRange;
  texture: TTexture | null;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
}

/** The one upstream primitive a source patch needs; it preserves every non-source quad field. */
export interface SourcePatchTarget<TTexture = unknown> {
  kindNameAt(index: number): string;
  readQuad(index: number, out: QuadView): QuadView;
  patchQuadSource(index: number, texture: TTexture | null, srcX: number, srcY: number, srcW: number, srcH: number): void;
}

/** Caller-owned working memory, so a patch frame allocates nothing. See {@link createPatchScratch}. */
export interface PatchScratch {
  quad: QuadView;
  nine: NinePatchView;
  alphas: StreamedAlphas;
  /** The plan: parallel arrays of command interval and multiplier, filled by VALIDATE and spent by APPLY. */
  starts: number[];
  ends: number[];
  ks: number[];
  planned: number;
  /** The subtree walk's explicit stack (id, applied cascade, new cascade). */
  ids: string[];
  cascadeApplied: number[];
  cascadeNew: number[];
  depth: number;
  /** Nodes this call has already walked — the guard against a nested root being patched twice. */
  seen: Set<string>;
  /** Source-plan command indices and replacement payloads; kept separate from the opacity range plan. */
  sourceIndexes: number[];
  sourceTextures: unknown[];
  sourceXs: number[];
  sourceYs: number[];
  sourceWs: number[];
  sourceHs: number[];
  sourcePlanned: number;
  sourceSeen: Set<number>;
}

/** What one attempt did. Reused per frame by the caller; never retained here. */
export interface PatchOutcome {
  patched: boolean;
  bail: PatchBailReason | null;
  /** Commands whose colour was written. */
  quads: number;
  /** Nodes that contributed at least one of them. */
  nodes: number;
  /** Nodes the walk visited, patched or not — the cost of an attempt, including one that bailed. */
  visited: number;
}

/**
 * Views and buffers for one stage. The two views are gsw's own shapes; the caller passes them in because
 * `createQuadView` is a value import this module deliberately does not take (see the header's purity note).
 */
export function createPatchScratch(quad: QuadView, nine: NinePatchView): PatchScratch {
  return {
    quad,
    nine,
    alphas: { mod: 1, self: 1 },
    starts: [],
    ends: [],
    ks: [],
    planned: 0,
    ids: [],
    cascadeApplied: [],
    cascadeNew: [],
    depth: 0,
    seen: new Set(),
    sourceIndexes: [],
    sourceTextures: [],
    sourceXs: [],
    sourceYs: [],
    sourceWs: [],
    sourceHs: [],
    sourcePlanned: 0,
    sourceSeen: new Set()
  };
}

/**
 * Patch already-resident intent-frame sources in place, or write nothing.
 *
 * The only accepted shape is exactly one ordinary quad. `emitAtlasRegion` is the build-time source of that
 * contract; nine-patches, fill-plus-texture pairs and any future multi-command paint all rebuild. Validation fills
 * caller-owned arrays first, then the apply loop updates texture handle and UVs as one list operation per command.
 */
export function planSource<TTexture>(
  sources: readonly SourcePatch<TTexture>[],
  target: SourcePatchTarget<TTexture>,
  scratch: PatchScratch,
  out: PatchOutcome
): PatchOutcome {
  out.patched = false;
  out.bail = null;
  out.quads = 0;
  out.nodes = 0;
  out.visited = 0;
  scratch.sourcePlanned = 0;
  scratch.sourceSeen.clear();

  // `SAMPLE_SOURCE` without a concrete intent entry is never a harmless no-op: accepting it would paint the list
  // from the previous frame while telling the renderer that every sampled change was applied.
  if (sources.length === 0) {
    out.bail = "source";
    return out;
  }

  for (const source of sources) {
    out.visited++;
    if (source.texture === null) {
      out.bail = "sourceTexture";
      return out;
    }
    if (
      !Number.isFinite(source.srcX) ||
      !Number.isFinite(source.srcY) ||
      !(source.srcW > 0) ||
      !(source.srcH > 0) ||
      source.range.paintEnd !== source.range.start + 1
    ) {
      out.bail = "sourceShape";
      return out;
    }
    const index = source.range.start;
    // A duplicate command would make the final source order-dependent; it is a changed command shape, not a
    // harmless repeated sample.
    if (scratch.sourceSeen.has(index) || target.kindNameAt(index) !== "quad") {
      out.bail = "sourceShape";
      return out;
    }
    // Atlas fitting may depend on the region's extent. Equal extents are the narrow proof that this is UV/handle
    // only; a frame with a different extent falls through to the builder, which owns that geometry.
    const current = target.readQuad(index, scratch.quad);
    if (current.srcW !== source.srcW || current.srcH !== source.srcH) {
      out.bail = "sourceShape";
      return out;
    }
    scratch.sourceSeen.add(index);
    const planned = scratch.sourcePlanned++;
    scratch.sourceIndexes[planned] = index;
    scratch.sourceTextures[planned] = source.texture;
    scratch.sourceXs[planned] = source.srcX;
    scratch.sourceYs[planned] = source.srcY;
    scratch.sourceWs[planned] = source.srcW;
    scratch.sourceHs[planned] = source.srcH;
  }

  out.patched = true;
  return out;
}

/** Spend a source plan {@link planSource} has already validated. This function cannot refuse. */
export function applySourcePlan<TTexture>(
  target: SourcePatchTarget<TTexture>,
  scratch: PatchScratch,
  out: PatchOutcome
): PatchOutcome {
  for (let i = 0; i < scratch.sourcePlanned; i++) {
    target.patchQuadSource(
      scratch.sourceIndexes[i],
      scratch.sourceTextures[i] as TTexture,
      scratch.sourceXs[i],
      scratch.sourceYs[i],
      scratch.sourceWs[i],
      scratch.sourceHs[i]
    );
    out.quads++;
    out.nodes++;
  }
  return out;
}

/** Convenience wrapper for unit callers that do not need to compose source validation with another patch tier. */
export function patchSource<TTexture>(
  sources: readonly SourcePatch<TTexture>[],
  target: SourcePatchTarget<TTexture>,
  scratch: PatchScratch,
  out: PatchOutcome
): PatchOutcome {
  planSource(sources, target, scratch, out);
  return out.patched ? applySourcePlan(target, scratch, out) : out;
}

/** The alpha a node's paint was composed at, from an override-or-streamed pair. */
function ownAlphaOf(node: MirrorNode, override: AlphaOverride | undefined, cascade: number, out: StreamedAlphas): number {
  streamedAlphasOf(node, out);
  const mod = override?.mod ?? out.mod;
  const self = override?.self ?? out.self;
  return cascade * mod * self;
}

/** The factor a node hands DOWN — its `modulate.a` half, which is the only one that cascades. */
function cascadeFactorOf(node: MirrorNode, override: AlphaOverride | undefined, out: StreamedAlphas): number {
  streamedAlphasOf(node, out);
  return override?.mod ?? out.mod;
}

/**
 * Patch every quad whose alpha changed, or refuse and touch nothing.
 *
 * `roots` is the set of nodes whose alpha the sweep just moved (`opacitySampledIds`). Their subtrees are the
 * affected set BY CONSTRUCTION: `modulate.a` cascades and nothing else in the list depends on alpha.
 */
export function patchOpacity(
  roots: ReadonlySet<string>,
  env: PatchEnv,
  target: PatchTarget,
  scratch: PatchScratch,
  out: PatchOutcome
): PatchOutcome {
  planOpacity(roots, env, target, scratch, out);
  return out.patched ? applyOpacityPlan(target, scratch, out) : out;
}

/** Validate an opacity patch and retain its ranges without mutating the list. */
export function planOpacity(
  roots: ReadonlySet<string>,
  env: PatchEnv,
  target: PatchTarget,
  scratch: PatchScratch,
  out: PatchOutcome
): PatchOutcome {
  out.patched = false;
  out.bail = null;
  out.quads = 0;
  out.nodes = 0;
  out.visited = 0;
  scratch.planned = 0;
  scratch.seen.clear();

  for (const rootId of roots) {
    const node = env.nodeOf(rootId);
    if (node === undefined) {
      out.bail = "unknownNode";
      return out;
    }
    // ONE WALK UP THE ANCESTORS answers three questions at once, and all three are cheap at this depth.
    let cascadeApplied = 1;
    let cascadeNew = 1;
    let skipRoot = false;
    for (let p = node.parentId; p != null; ) {
      // (1) Is an ancestor also a root? Then the outer walk covers this subtree, and covering it twice would
      // square this node's own factor. Not a bail — a fade inside a fade is legal and composes.
      if (roots.has(p)) {
        skipRoot = true;
        break;
      }
      const parent = env.nodeOf(p);
      // (2) Hidden or orphaned above? The walk holds the whole subtree invisible, so it has no commands at all.
      if (parent === undefined || parent.visible === false) {
        skipRoot = true;
        break;
      }
      // (3) The cascade this subtree starts from, on both sides of the change.
      cascadeApplied *= cascadeFactorOf(parent, env.appliedAlphaOf(p), scratch.alphas);
      cascadeNew *= cascadeFactorOf(parent, env.currentAlphaOf(p), scratch.alphas);
      p = parent.parentId;
    }
    if (skipRoot) {
      continue;
    }
    const bail = walkSubtree(rootId, cascadeApplied, cascadeNew, env, target, scratch, out);
    if (bail !== null) {
      out.bail = bail;
      return out;
    }
  }

  out.patched = true;
  return out;
}

/** Spend a {@link planOpacity} result. This cannot refuse. */
export function applyOpacityPlan(
  target: PatchTarget,
  scratch: PatchScratch,
  out: PatchOutcome
): PatchOutcome {
  // APPLY — planOpacity wrote nothing, so every range here was fully validated.
  for (let i = 0; i < scratch.planned; i++) {
    const k = scratch.ks[i];
    const end = scratch.ends[i];
    for (let index = scratch.starts[i]; index < end; index++) {
      const kind = target.kindNameAt(index);
      const view: QuadView =
        kind === "ninePatch" ? target.readNinePatch(index, scratch.nine) : target.readQuad(index, scratch.quad);
      target.patchQuadColor(index, view.r * k, view.g * k, view.b * k, view.a * k);
      out.quads++;
    }
    out.nodes++;
  }
  return out;
}

/** VALIDATE one root's subtree: fill the plan, or answer the reason this frame has to rebuild. */
function walkSubtree(
  rootId: string,
  cascadeApplied: number,
  cascadeNew: number,
  env: PatchEnv,
  target: PatchTarget,
  scratch: PatchScratch,
  out: PatchOutcome
): PatchBailReason | null {
  scratch.depth = 0;
  push(scratch, rootId, cascadeApplied, cascadeNew);
  while (scratch.depth > 0) {
    scratch.depth--;
    const id = scratch.ids[scratch.depth];
    const inApplied = scratch.cascadeApplied[scratch.depth];
    const inNew = scratch.cascadeNew[scratch.depth];
    if (scratch.seen.has(id)) {
      continue;
    }
    scratch.seen.add(id);
    out.visited++;

    const node = env.nodeOf(id);
    if (node === undefined) {
      return "unknownNode";
    }
    if (node.visible === false) {
      // Hidden cascades in the walk, so this whole subtree pushed nothing. Not descended into, and not a bail:
      // there is no command under it for an alpha to be wrong about.
      continue;
    }
    if (overlayKindOf(node) !== null) {
      // Text, a shader/particle surface, a spine still, a comet. Its alpha lives on a DOM element or in a record
      // the overlay sync writes — neither of which a list patch can reach.
      return "overlay";
    }

    const applied = env.appliedAlphaOf(id);
    const current = env.currentAlphaOf(id);
    const ownApplied = ownAlphaOf(node, applied, inApplied, scratch.alphas);
    const ownNew = ownAlphaOf(node, current, inNew, scratch.alphas);
    if (nodeIsPainting(node, ownApplied) !== nodeIsPainting(node, ownNew)) {
      return "classFlip";
    }
    if (ownApplied > 1 || ownNew > 1) {
      return "clamp";
    }

    const range = env.rangeOf(id);
    if (range !== undefined && ownNew !== ownApplied) {
      if (!(ownApplied > 0)) {
        return "zeroApplied";
      }
      const k = ownNew / ownApplied;
      for (let index = range.start; index < range.paintEnd; index++) {
        const kind = target.kindNameAt(index);
        if (kind !== "quad" && kind !== "ninePatch") {
          return "polyline";
        }
        const view: QuadView =
          kind === "ninePatch" ? target.readNinePatch(index, scratch.nine) : target.readQuad(index, scratch.quad);
        // The recorded alpha must be consistent with the node alpha it was composed from — see the header's
        // clamping note. `>` and not `>=`: a paint colour of exactly 1 is the common case, not a suspicious one.
        if (view.a > ownApplied * (1 + CLAMP_EPS)) {
          return "clamp";
        }
        if (view.a * k > 1) {
          return "clamp";
        }
      }
      plan(scratch, range, k);
    }

    const kids = env.childrenOf(id);
    const childApplied = inApplied * cascadeFactorOf(node, applied, scratch.alphas);
    const childNew = inNew * cascadeFactorOf(node, current, scratch.alphas);
    for (let i = 0; i < kids.length; i++) {
      push(scratch, kids[i], childApplied, childNew);
    }
  }
  return null;
}

function push(scratch: PatchScratch, id: string, applied: number, next: number): void {
  scratch.ids[scratch.depth] = id;
  scratch.cascadeApplied[scratch.depth] = applied;
  scratch.cascadeNew[scratch.depth] = next;
  scratch.depth++;
}

function plan(scratch: PatchScratch, range: NodeCommandRange, k: number): void {
  scratch.starts[scratch.planned] = range.start;
  scratch.ends[scratch.planned] = range.paintEnd;
  scratch.ks[scratch.planned] = k;
  scratch.planned++;
}

// --- TIER 3, TRANSFORM PATCHING (R7 W3-T) ------------------------------------------------------------------------
//
// WHY THIS IS NOT "THE SAME THING WITH A DIFFERENT CHANNEL", AND WHY IT IS POSSIBLE ANYWAY.
//
// The header above says a transform override is a subtree re-emit wearing tier 3's clothes, and for a TWEEN it
// still is. This arm is narrower on purpose: it patches LOCAL ANIMS ONLY — the idle vocabulary (`idleAnim.ts`)
// the browser replays on its own clock because the headless instance freezes it. That one restriction is what
// turns the six consumers into one multiply, because a local anim NEVER REACHES `gGame`. It enters at `ownDraw`
// and `gRaw`, which means:
//
//   * the spread claim is computed at `gGame` and is blind to it (the walk's drawn-pose rebase fires for a
//     transform OVERRIDE and its subtree, and a local anim deliberately sets neither — `buildDrawList`'s
//     `drawnMoved`) — so instability 4 is unreachable rather than refused;
//   * `hitEntry.mGame` is untouched, so a tap still sends the pose the game believes in, which is the invariant
//     the whole hit-grid gate holds this backend to;
//   * the input registry, the spread bank and the comet's head sample all read game space and see nothing.
//
// THE ONE MULTIPLIER. Within one animated node's paint-order span, and with no stamp, no cosmetic offset and no
// clipper INSIDE it, every node draws at `m = C · g` with the SAME `C` (`LocalAnimFrame.outer`) — because `C` is
// built from the accumulated view-scale product and the inherited offset, and both are constant exactly when
// nothing in the span introduces a new one. So if the root's rendered global moves from `g` to `g'`, every node's
// drawn matrix moves by the single left-multiplier
//
//     D = (C · g') · (C · g)⁻¹
//
// and that is true of the node's own quads, of the atlas regions inside them, of the injected fx/spine/text quads
// (which are `record.transform ∘ local`, and `record.transform` is `gFinal ∘ boxOrigin`), and of the overlay
// records themselves. `D` is computed once per moved root and spent over `order.ids.slice(spanStart, spanEnd)` —
// an O(1) slice, because paint-order spans are contiguous and asserted to be.
//
// THE SPREAD TERM (R21 B2), i.e. why a widened stage is NOT the exception it was written down as.
//
// This tier used to refuse `spreadFactor !== 1` outright, on the grounds that "`outer` is constant over a span
// only at factor 1". The premise is true and the conclusion does not follow. The walk composes
//
//     gFinal_i = outer · T(dx_i, 0) · gRaw_i          (`gSpread` adds `dx` into the translation column, X only)
//
// so the per-node multiplier is `C_i = outer · T(dx_i, 0)`, with ONE `outer` and a per-node scalar `dx_i`. And
// `dx_i` is BLIND to a local anim: `computeSpread` is evaluated at `gGame`, at a `SpreadCtx` threaded from
// ancestors' `gGame`, over a box read off the node — none of which the idle loop touches, because it enters at
// `ownDraw`/`gRaw` and stops there. (The one exception is `applyDrawnFieldRebase`, which re-derives the claim from
// `gRaw` when `?spreadEndpoint` is on AND an ancestor carries a transform override. The build publishes that as
// `LocalAnimFrame.spreadRebased` and this tier still refuses it — see the `spread` bail.)
//
// So with `gRaw_i = g · rel_i` moving to `g' · rel_i`, write `Δ = g' · g⁻¹` and the exact per-node delta is
//
//     D_i = C_i · Δ · C_i⁻¹ = outer · T(dx_i) · Δ · T(−dx_i) · outer⁻¹
//
// Now conjugating an affine `Δ = [A | t]` by a translation moves ONLY its translation column:
//
//     T(d) · Δ · T(−d) = [A | t + (I − A)·d]
//
// with `d = (dx_i, 0)`, so the whole per-node term is the scalar `dx_i` times the FIRST COLUMN of `I − A` — which
// is `(0, 0)` whenever `Δ` maps e₁ to e₁, i.e. for every pure translation, and idle bobs are pure translations.
// Lifting that through `outer` (whose linear part is what conjugation applies to a translation) gives
//
//     D_i = T((dx_i − dx_root) · v) · D_root ,   v = A_outer·e₁ − A_D_root·(A_outer·e₁)
//
// — `v` needs no inverse, because `A_D_root = A_outer · A · A_outer⁻¹` already carries the conjugation, and
// `T(dx)` has an identity linear part so `A_C = A_outer`. `v` is computed ONCE per moved root; per node the
// correction is a subtract and two multiply-adds into the translation column of a matrix the apply loop was
// already going to spend. When `v` is zero — the common case — the loop takes `D_root` verbatim and this tier is
// bit-for-bit what it was at factor 1.
//
// WHAT THAT BUYS, measured: at a 1878x954 viewport (a maximized 1920x1080 desktop browser, aspect 1.97) the
// blanket refusal took 295 of 295 frames and every one of them was a full `buildDrawList` — 15 ms of JS per
// frame. Narrowing the same window below 16:9 patched 94% of frames at 1 ms. The refusal was not costing "a
// widened stage its idle frames"; it was costing every maximized desktop browser all of them.
//
// THE TWO NON-LINEAR READERS ARE REFUSED, not approximated: `nodeClipSpec` bakes a design-space rect out of the
// node's global (and gsw has no `patchClipRect`), and `emitPolyline` bakes every point. Neither is a
// left-multiply of anything.
//
// THE GLYPH TERM, i.e. why a label is NOT a third non-linear reader.
//
// This tier used to refuse any span containing a command that is not `quad`/`ninePatch`, under the name
// `polyline`, on the grounds that "a stroke's geometry is a list of baked points, not a matrix". True of a
// stroke. There are SIX command kinds, and the one that bail actually blocked is `glyphs` — so with
// canvas text every label on the screen refused the whole tier, and a combat screen rebuilt 370 of 371
// frames at 27 ms of JS each where the same screen with its text in the DOM patched 94% of them at 1 ms.
//
// A glyph run is a matrix and a payload, exactly like a quad. `GlyphsView.m` is documented as "the 2x3 affine
// that maps the run's local space into design space, in the same Godot `Transform2D` order as `QuadView.m`", and
// gsw ships `patchGlyphsTransform` for precisely this consumer. The walk composes
//
//     m_run = record.transform · inner ,   inner = S(blockScale about the box centre) · T(run origin)
//
// (`paintSpec.emitTextGlyphs`), and `inner` is a function of the LABEL's own layout — the block scale and the
// pen origin of its line — neither of which a pose delta touches. `applyTransformPlan` already re-places
// `record.transform` by `D` in step (2), so the frame a rebuild would write is `(D · record.transform) · inner`,
// which is `D · m_run`: the same left-multiply this tier already spends on every quad in the span. The run's
// `pixelsPerEm`, colours, slot ids and pen positions are untouched, which is what makes it byte-identical rather
// than merely close. ROTATION STAYS IN `m` for the reason `GlyphsView` gives (the shader dilates each outline by
// half a SCREEN pixel and works out how far that is through this matrix); nothing here touches `positions`.
//
// AND THE ONE CASE THAT REALLY DOES DIVERGE — `textScale`. A label's PIXELS are keyed by scale on both text
// backends: the raster path folds the composed scale into `rasterScaleFor` and thus into `textDigest`, so a
// scaling delta re-keys the raster, re-sizes the quad and can move it to another atlas page — none of which a
// matrix write can express. A PURE TRANSLATION changes none of it, and
// every idle bob is a pure translation (the same fact `THE SPREAD TERM` turns on), so the refusal is priced at
// the pulses and costs the bobs nothing. It is keyed on `isTextDrawn` — the build's own `textQuadIds`, which is
// filled by BOTH text paths — rather than on the command kind, because the raster path's label is an ordinary
// `quad` that no kind test could pick out of its neighbours.
//
// STALE POLICY, stated because a patch tier that leaves nothing stale would be a rebuild:
//   * `hitEntries.mFinal` is PATCHED IN PLACE. It is not a side-product — by the round law `mFinal` IS the drawn
//     pose, so leaving it would put the touch model behind the picture on every bobbing intent. The entries are
//     pushed in walk order, so the span's are a contiguous run by `.order` and a binary search finds it.
//   * `capturedGlobals` is REFUSED, not left stale: the eager-scroll engine reads `scrollRenderedY` out of it.
//   * `OverlayRecord.coveredAbove` IS LEFT STALE, bounded by the chain (15 links at 30 fps ≈ half a second), and
//     that is a considered choice rather than an oversight: its only consumer is the hoist rule, whose population
//     is fx-kind surfaces; the DOM arm is PERMANENTLY stale on the same fact; and a patched span moves TOWARD the
//     reference rather than away from it. Filed as a residual, named here so it is not rediscovered.

/** How many TRANSFORM patches may follow one build. Tighter than the alpha bound — see {@link PATCH_CHAIN_MAX}. */
export const PATCH_TRANSFORM_CHAIN_MAX = 15;

/** Below this, `D` is the identity to float32 and the root is skipped rather than written. */
const IDENTITY_EPS = 1e-9;

/** A 2x3 affine, in `Transform2D` order — `affine.Affine` without the value import (see the header's purity note). */
export type PatchAffine = readonly [number, number, number, number, number, number];

/** The mutable twin, for the arrays this arm writes into. */
export type MutablePatchAffine = [number, number, number, number, number, number];

/** One node's matrices, as {@link planTransform} reads them. Structurally `buildDrawList.LocalAnimFrame`. */
export interface PatchAnimFrame {
  drawn: MutablePatchAffine;
  outer: PatchAffine;
  base: PatchAffine;
  wire: readonly number[] | null;
  /** The root's own spread shift — the `T(dx, 0)` half of its `C`. See `THE SPREAD TERM`. */
  spreadDx: number;
  /** The span's field claims ride the drawn pose, so `dx` is no longer anim-blind. Refused. */
  spreadRebased: boolean;
}

/** This frame's pose for one node. Structurally `buildDrawList.LocalAnim`. */
export interface PatchAnimPose {
  pre: readonly number[] | null;
  post: readonly number[] | null;
}

/** One node's subtree interval in the paint order, plus its own paint index. */
export interface PatchSpan {
  order: number;
  spanStart: number;
  spanEnd: number;
}

/**
 * The scene and the last build, as the questions this arm asks about them.
 *
 * Every predicate below is named for the bail it produces, so a reader of the histogram can find the line that
 * raised it without reading the walk.
 */
export interface TransformPatchEnv {
  /** Node ids in paint order — what a span slices. */
  orderIds: readonly string[];
  spanOf(id: string): PatchSpan | undefined;
  /** The frames the LAST BUILD published. Its KEY SET is the root set — see {@link planTransform}. */
  animFrames: ReadonlyMap<string, PatchAnimFrame>;
  /** This frame's pose, or null when the node dropped out and must return to rest. */
  animNowOf(id: string): PatchAnimPose | null;
  rangeOf(id: string): NodeCommandRange | undefined;
  isViewScaleCandidate(id: string): boolean;
  isOverlayClipped(id: string): boolean;
  isClipper(id: string): boolean;
  hasCosmeticOffset(id: string): boolean;
  isCaptured(id: string): boolean;
  hasTransformOverride(id: string): boolean;
  hasTrailQuad(id: string): boolean;
  /**
   * Did the CANVAS draw this node's label this build (`buildDrawList`'s `textQuadIds`, either text path)?
   *
   * Read only when the delta's linear part is not the identity — see `THE GLYPH TERM` — so a translating idle
   * loop never touches this set at all, and it is empty when the current build drew no text labels.
   */
  isTextDrawn(id: string): boolean;
  /**
   * The node's applied spread shift as the LAST BUILD wrote it (`spreadDxOut`), 0 at factor 1 — the per-node
   * scalar in `THE SPREAD TERM`. Read only when the root's `v` is non-zero, i.e. only when the anim's own delta
   * has a linear part, so a translating idle loop never touches this map at all.
   */
  spreadDxOf(id: string): number;
  /** The paint order of the stage backstop, or -1. */
  backstopOrder: number;
}

/** The list, as the methods a transform patch needs on top of {@link PatchTarget}'s. */
export interface TransformPatchTarget {
  kindNameAt(index: number): string;
  readQuad(index: number, out: QuadView): QuadView;
  readNinePatch(index: number, out: NinePatchView): NinePatchView;
  patchQuadTransform(index: number, m: ArrayLike<number>): void;
  /**
   * …and the GLYPH pair — see `THE GLYPH TERM`. `readGlyphs` REPLACES the view's `slots`/`positions` when they
   * cannot hold the run, so the scratch view settles at the high-water mark of the runs it has read and then
   * allocates nothing, exactly like the list's own arenas.
   */
  readGlyphs(index: number, out: GlyphsView): GlyphsView;
  patchGlyphsTransform(index: number, m: ArrayLike<number>): void;
}

/** An overlay record, as this arm mutates it. Structurally `paintSpec.OverlayRecord`. */
export interface PatchOverlayRecord {
  order: number;
  transform: MutablePatchAffine;
}

/** A hit entry, as this arm mutates it. Structurally `hitTest.HitEntry` — `mGame` is deliberately not here. */
export interface PatchHitEntry {
  order: number;
  mFinal: MutablePatchAffine;
}

/** Caller-owned working memory for the transform arm. See {@link createTransformScratch}. */
export interface TransformScratch {
  quad: QuadView;
  nine: NinePatchView;
  /** The glyph twin of the two above — see {@link TransformPatchTarget.readGlyphs}. */
  glyphs: GlyphsView;
  /** The plan: per moved root, its span and the multiplier `D` its whole span takes. */
  spanStarts: number[];
  spanEnds: number[];
  rootIds: string[];
  /** `D` per planned root, six floats each, flat. */
  deltas: number[];
  /** The pose to re-bank into `PatchAnimFrame.drawn` once the write succeeds, six floats each, flat. */
  posed: number[];
  /**
   * `THE SPREAD TERM`'s per-root constants, two floats each, flat: the vector `v` a node's `dx − dxRoot` scales.
   * `(0, 0)` — the whole of the translating case, and every frame at factor 1 — means "spend `D` verbatim".
   */
  spreadV: number[];
  /** The root's own `dx`, per planned root — the origin the per-node correction is measured from. */
  spreadRootDx: number[];
  planned: number;
  /** Scratch for one composition, so a planned frame allocates nothing after warmup. */
  work: MutablePatchAffine;
  /** …and for the per-node spread delta, which is a DIFFERENT matrix from the one `work` is composing into. */
  spreadWork: MutablePatchAffine;
}

export function createTransformScratch(quad: QuadView, nine: NinePatchView, glyphs: GlyphsView): TransformScratch {
  return {
    quad,
    nine,
    glyphs,
    spanStarts: [],
    spanEnds: [],
    rootIds: [],
    deltas: [],
    posed: [],
    spreadV: [],
    spreadRootDx: [],
    planned: 0,
    work: [1, 0, 0, 1, 0, 0],
    spreadWork: [1, 0, 0, 1, 0, 0]
  };
}

/** What one transform attempt did. Reused per frame by the caller; never retained here. */
export interface TransformOutcome {
  /** Did the plan validate? A false here is a REBUILD, and nothing has been written. */
  ok: boolean;
  bail: PatchBailReason | null;
  /** Roots whose span actually moved (an identity `D` is planned as nothing). */
  roots: number;
  /** Commands whose matrix was rewritten. */
  commands: number;
  /** Overlay records re-placed. */
  records: number;
  /** Hit entries whose `mFinal` was re-posed. */
  hits: number;
  /** Nodes the validation walk visited — the cost of an attempt, including one that refused. */
  visited: number;
}

/**
 * PLAN the re-pose of every locally-animated subtree, writing NOTHING.
 *
 * THE ROOT SET IS THE BANKED MAP, not this frame's samples, and that is the difference between a correct tier and
 * one that strands a node. A node that stops animating between two frames is absent from `animNowOf` — so its
 * pose composes with `pre = post = null`, `D` returns it to rest, and the picture is the one a rebuild would have
 * drawn. Take the root set from this frame's samples instead and that node simply keeps the last bob it was
 * caught at, forever, until something else forces a build.
 *
 * The converse is the `unknownAnim` refusal: a node animating NOW that the last build published no frame for
 * cannot be posed from four matrices that do not exist.
 */
export function planTransform(
  env: TransformPatchEnv,
  target: TransformPatchTarget,
  scratch: TransformScratch,
  out: TransformOutcome
): TransformOutcome {
  out.ok = false;
  out.bail = null;
  out.roots = 0;
  out.commands = 0;
  out.records = 0;
  out.hits = 0;
  out.visited = 0;
  scratch.planned = 0;

  for (const [rootId, frame] of env.animFrames) {
    const span = env.spanOf(rootId);
    if (span === undefined) {
      // The order no longer holds the node. Only reachable if the state moved under the list, which the frame
      // level already refuses — kept because a missing span cannot be walked and must not be guessed at.
      out.bail = "unknownAnim";
      return out;
    }
    if (frame.spreadRebased) {
      // This span's field claims were re-derived from the DRAWN pose, so `dx` moves with the anim and no
      // conjugation by a CONSTANT `T(dx)` describes the frame a rebuild would write. See `THE SPREAD TERM`.
      out.bail = "spread";
      return out;
    }
    const now = env.animNowOf(rootId);
    const posed = composeAnimPose(env, frame, now);
    // `D_root = (C · posed) · drawn⁻¹`, and `drawn` is already `C · <the pose in the list>` — where `C` is
    // `outer · T(dx, 0)`, the root's own spread shift included. At factor 1 `dx` is 0 and this IS `outer`.
    const c = mulTranslateX(frame.outer, frame.spreadDx);
    const gNew = mul(c, posed);
    const inv = invert(frame.drawn);
    if (inv === null) {
      // A singular drawn pose — a fully collapsed scale. There is no multiplier that recovers from it.
      out.bail = "unknownAnim";
      return out;
    }
    const d = mul(gNew, inv);
    if (isIdentity(d)) {
      // The node is where the list already has it: nothing to plan, nothing to refuse over. A `pulseScaleFade`
      // sitting at its own cycle boundary lands here, and so does every root on the frame after a rebuild.
      continue;
    }
    // `THE GLYPH TERM`'s one refusal, hoisted to the root because `D`'s linear part is a property of the DELTA and
    // not of any node in the span: a translating bob asks `isTextDrawn` nothing at all.
    const bail = validateSpan(rootId, span, env, target, out, linearIsIdentity(d));
    if (bail !== null) {
      out.bail = bail;
      return out;
    }
    // `v = A_outer·e₁ − A_D·(A_outer·e₁)` — the per-node spread correction's direction, zero for a translating
    // delta. Derived rather than measured, so a rotation or a pulse gets the exact answer and not an approximation.
    const px = frame.outer[0];
    const py = frame.outer[1];
    const vx = px - (d[0] * px + d[2] * py);
    const vy = py - (d[1] * px + d[3] * py);
    planSpan(scratch, rootId, span, d, gNew, vx, vy, frame.spreadDx);
  }
  out.ok = true;
  return out;
}

/**
 * APPLY a validated plan: the list's matrices, the overlay records' placements and the hit entries' drawn poses.
 *
 * Separated from the planning above so a refusal on the LAST root still leaves the previous frame's list intact —
 * the same validate-then-apply discipline `patchOpacity` takes, and for the same reason: a half-written list is a
 * frame the renderer cannot fix by rebuilding.
 */
export function applyTransformPlan(
  env: TransformPatchEnv,
  target: TransformPatchTarget,
  records: readonly PatchOverlayRecord[],
  hits: readonly PatchHitEntry[],
  scratch: TransformScratch,
  out: TransformOutcome
): void {
  for (let p = 0; p < scratch.planned; p++) {
    const at = p * 6;
    const d: MutablePatchAffine = [
      scratch.deltas[at],
      scratch.deltas[at + 1],
      scratch.deltas[at + 2],
      scratch.deltas[at + 3],
      scratch.deltas[at + 4],
      scratch.deltas[at + 5]
    ];
    const spanStart = scratch.spanStarts[p];
    const spanEnd = scratch.spanEnds[p];
    // `THE SPREAD TERM`. Zero on every frame at factor 1 AND on every translating idle bob at any factor, so the
    // hoisted test is what keeps the widescreen path exactly as cheap as the 16:9 one it replaces.
    const vx = scratch.spreadV[p * 2];
    const vy = scratch.spreadV[p * 2 + 1];
    const spreading = vx !== 0 || vy !== 0;
    const rootDx = scratch.spreadRootDx[p];
    const spreadDelta = scratch.spreadWork;
    /**
     * `D_i = T((dx_i − dx_root) · v) · D_root` — the same matrix with its translation column moved, which is all a
     * left translation can do. Returns `d` itself (not a copy) for every node the correction does not move, so the
     * non-spread path allocates and computes nothing.
     */
    const deltaFor = (id: string): PatchAffine => {
      if (!spreading) {
        return d;
      }
      const s = env.spreadDxOf(id) - rootDx;
      if (s === 0) {
        return d;
      }
      spreadDelta[0] = d[0];
      spreadDelta[1] = d[1];
      spreadDelta[2] = d[2];
      spreadDelta[3] = d[3];
      spreadDelta[4] = d[4] + s * vx;
      spreadDelta[5] = d[5] + s * vy;
      return spreadDelta;
    };

    // (1) THE LIST. Per-node ranges rather than one command interval: a range holds a node's OWN paint, and the
    // gaps between them are the clip pushes and pops this arm must not touch.
    for (let i = spanStart; i < spanEnd; i++) {
      const id = env.orderIds[i];
      const range = env.rangeOf(id);
      if (range === undefined) {
        continue;
      }
      const dNode = deltaFor(id);
      for (let index = range.start; index < range.paintEnd; index++) {
        const kind = target.kindNameAt(index);
        if (kind === "glyphs") {
          // THE GLYPH PAIR, and it must be the glyph pair: `patchQuadTransform` THROWS on a run (gsw's
          // `requireQuadLike`), so a shared path here would not be a wrong picture, it would be an exception
          // thrown from inside a half-applied plan. See `THE GLYPH TERM` for why `D · m` is the whole of the job.
          const run = target.readGlyphs(index, scratch.glyphs);
          mulInto(scratch.work, dNode, run.m);
          target.patchGlyphsTransform(index, scratch.work);
          out.commands++;
          continue;
        }
        const view: QuadView =
          kind === "ninePatch" ? target.readNinePatch(index, scratch.nine) : target.readQuad(index, scratch.quad);
        mulInto(scratch.work, dNode, view.m);
        target.patchQuadTransform(index, scratch.work);
        out.commands++;
      }
    }

    // (2) THE OVERLAY RECORDS. Without this the whole tier is worth nothing on the screen it was built for: the
    // intent bob's subtree is a sprite, a particle overlay and a text overlay, so refusing overlays would refuse
    // the bob itself on every frame. Patching them is free — every injected quad composes `record.transform` and
    // the overlay's own placement/clip writers are numeric-cached readers of it.
    //
    // KEYED THROUGH `orderIds`, not through the record's own id: `order` IS the index of the node's own paint in
    // the paint order (`PaintOrderEntry.order`), which is the same index space `spanStart`/`spanEnd` slice.
    for (let r = lowerBound(records, spanStart); r < records.length && records[r].order < spanEnd; r++) {
      mulInto(records[r].transform, deltaFor(env.orderIds[records[r].order]), records[r].transform);
      out.records++;
    }

    // (3) THE HIT ENTRIES' DRAWN POSE. `mGame` is untouched by construction — see the section header.
    for (let h = lowerBound(hits, spanStart); h < hits.length && hits[h].order < spanEnd; h++) {
      mulInto(hits[h].mFinal, deltaFor(env.orderIds[hits[h].order]), hits[h].mFinal);
      out.hits++;
    }

    // (4) RE-BANK. The list now holds this pose, so the NEXT patch in the chain measures its `D` from here — the
    // `bankAppliedAlphas` twin, and the reason a chain of patches converges on the same picture a rebuild draws.
    const frame = env.animFrames.get(scratch.rootIds[p]);
    if (frame !== undefined) {
      const posedAt = p * 6;
      for (let i = 0; i < 6; i++) {
        frame.drawn[i] = scratch.posed[posedAt + i];
      }
    }
    out.roots++;
  }
}

/** VALIDATE one root's span. Writes nothing; answers the reason this frame has to rebuild, or null. */
function validateSpan(
  rootId: string,
  span: PatchSpan,
  env: TransformPatchEnv,
  target: TransformPatchTarget,
  out: TransformOutcome,
  translating: boolean
): PatchBailReason | null {
  // ONE TEST FOR THE BACKSTOP, not one per node: `backstopOrder` IS a paint index, and the span IS an interval of
  // paint indices. What it can lose by moving is covered; what it could GAIN is not reachable by a bounded local
  // anim — a box that does not span the design stage cannot be made to by a 10 px bob, and one that does span it
  // while painting EARLIER than the current backstop never wins the `>` test anyway. Named as a residual.
  if (env.backstopOrder >= span.spanStart && env.backstopOrder < span.spanEnd) {
    return "backstop";
  }
  for (let i = span.spanStart; i < span.spanEnd; i++) {
    const id = env.orderIds[i];
    out.visited++;
    if (id !== rootId && env.animFrames.has(id)) {
      return "nestedRoots";
    }
    if (env.isViewScaleCandidate(id)) {
      return "viewScale";
    }
    if (env.isClipper(id)) {
      return "clipRect";
    }
    if (env.isCaptured(id)) {
      return "captured";
    }
    if (id !== rootId && env.hasCosmeticOffset(id)) {
      return "spanOffset";
    }
    if (id !== rootId && env.hasTransformOverride(id)) {
      return "spanOverride";
    }
    if (env.hasTrailQuad(id)) {
      return "trailQuad";
    }
    if (env.isOverlayClipped(id)) {
      return "overlayClip";
    }
    if (!translating && env.isTextDrawn(id)) {
      // A SCALING DELTA OVER A CANVAS-DRAWN LABEL. See `THE GLYPH TERM`: the label's pixels are keyed by scale, so
      // a rebuild would re-raster (or re-route) it and no matrix write can say that.
      return "textScale";
    }
    const range = env.rangeOf(id);
    if (range === undefined) {
      continue;
    }
    for (let index = range.start; index < range.paintEnd; index++) {
      const kind = target.kindNameAt(index);
      if (kind === "glyphs") {
        continue; // a run's `m` is a quad's `m` by another name — see `THE GLYPH TERM`
      }
      if (kind !== "quad" && kind !== "ninePatch") {
        // A stroke's geometry is a list of baked points, not a matrix. `patchQuadTransform` would throw on it —
        // and so would a clip rect, whose payload is a baked design-space box.
        return "polyline";
      }
    }
  }
  return null;
}

/**
 * This frame's rendered global for one animated node, through the walk's OWN composition law.
 *
 * `composeLocalAnimGlobal` is `buildDrawList`'s, imported rather than restated: this is the one place where a
 * second spelling of the law would produce a list that is self-consistent and still not the list a rebuild writes
 * — a divergence with no symptom until someone photographs it.
 */
function composeAnimPose(_env: TransformPatchEnv, frame: PatchAnimFrame, now: PatchAnimPose | null): PatchAffine {
  return composeLocalAnimGlobal(
    frame.base as MutablePatchAffine,
    frame.wire,
    null,
    now?.pre ?? null,
    now?.post ?? null
  );
}

function planSpan(
  scratch: TransformScratch,
  rootId: string,
  span: PatchSpan,
  d: PatchAffine,
  posed: PatchAffine,
  vx: number,
  vy: number,
  rootDx: number
): void {
  const at = scratch.planned * 6;
  for (let i = 0; i < 6; i++) {
    scratch.deltas[at + i] = d[i];
    scratch.posed[at + i] = posed[i];
  }
  scratch.spreadV[scratch.planned * 2] = vx;
  scratch.spreadV[scratch.planned * 2 + 1] = vy;
  scratch.spreadRootDx[scratch.planned] = rootDx;
  scratch.rootIds[scratch.planned] = rootId;
  scratch.spanStarts[scratch.planned] = span.spanStart;
  scratch.spanEnds[scratch.planned] = span.spanEnd;
  scratch.planned++;
}

/** First index whose `.order` is at or after `from`, over an array sorted by `.order` (the walk's own push order). */
function lowerBound(items: readonly { order: number }[], from: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].order < from) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// --- affine arithmetic, restated for the reason every other number in this module is (no value imports) ---------

function mul(m: PatchAffine, n: ArrayLike<number>): PatchAffine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

/**
 * `m · T(dx, 0)` — the node's own spread shift folded onto the RIGHT of `outer`, which is where the walk puts it
 * (`gFinal = outer · T(dx, 0) · gRaw`; `gSpread` adds `dx` into `gRaw`'s translation column). Right-multiplying by
 * a translation only moves the translation column, and by `m`'s own x-basis.
 */
function mulTranslateX(m: PatchAffine, dx: number): PatchAffine {
  return dx === 0 ? m : [m[0], m[1], m[2], m[3], m[4] + m[0] * dx, m[5] + m[1] * dx];
}

/** `out = m · n`, alias-safe on `out === n` — which is how a record re-places itself in one call. */
function mulInto(out: ArrayLike<number> & { [i: number]: number }, m: PatchAffine, n: ArrayLike<number>): void {
  const a = m[0] * n[0] + m[2] * n[1];
  const b = m[1] * n[0] + m[3] * n[1];
  const c = m[0] * n[2] + m[2] * n[3];
  const d = m[1] * n[2] + m[3] * n[3];
  const e = m[0] * n[4] + m[2] * n[5] + m[4];
  const f = m[1] * n[4] + m[3] * n[5] + m[5];
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = e;
  out[5] = f;
}

function invert(m: ArrayLike<number>): PatchAffine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0 || !Number.isFinite(det)) {
    return null;
  }
  const inv = 1 / det;
  const a = m[3] * inv;
  const b = -m[1] * inv;
  const c = -m[2] * inv;
  const d = m[0] * inv;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/**
 * Is the delta a PURE TRANSLATION — its 2x2 linear part the identity?
 *
 * The whole of `THE GLYPH TERM`'s refusal test, and the same epsilon {@link isIdentity} takes so the two cannot
 * disagree about a matrix that is identity to float32 in one and not the other. The translation column is
 * deliberately NOT tested: moving a label is exactly the case this tier exists to patch.
 */
function linearIsIdentity(m: PatchAffine): boolean {
  return (
    Math.abs(m[0] - 1) < IDENTITY_EPS &&
    Math.abs(m[1]) < IDENTITY_EPS &&
    Math.abs(m[2]) < IDENTITY_EPS &&
    Math.abs(m[3] - 1) < IDENTITY_EPS
  );
}

function isIdentity(m: PatchAffine): boolean {
  return (
    Math.abs(m[0] - 1) < IDENTITY_EPS &&
    Math.abs(m[1]) < IDENTITY_EPS &&
    Math.abs(m[2]) < IDENTITY_EPS &&
    Math.abs(m[3] - 1) < IDENTITY_EPS &&
    Math.abs(m[4]) < IDENTITY_EPS &&
    Math.abs(m[5]) < IDENTITY_EPS
  );
}
