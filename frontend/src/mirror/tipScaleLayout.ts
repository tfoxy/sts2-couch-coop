// THE HOVERTIP-SCALE LAYOUT — one copy, shared by both mirror backends.
//
// `hoverTipScaleMath.ts` owns the pivot/clamp GEOMETRY (and is the port of the native `HoverTipScaleMath`, so it
// must stay pure vector math the native tests can be read against). This module is the LAYOUT step above it:
// given a tip-set root, decide which of its children the enlargement is measured from, resolve the thing the tip
// POINTS AT, and turn both into the design-space matrix a backend applies to the whole tip subtree.
//
// WHY IT LIVES HERE — the argument `viewScaleLayout.ts` makes beside it, and it applies harder to this pass. The
// DOM backend has run this since Feature 1; the canvas backend ran NOTHING, so `?stage=canvas` drew every tooltip
// at 1.0 and in a different place (the pivot is chosen from the tip's own union, so the two stages disagreed on
// position as well as size). Reproducing the pass on the canvas side would mean a second copy of: the
// paint-bearing child rule, the straddle/single-block split, the owner-kind side choice, the side clamp and the
// view-scale owner-follow — five special cases that were each a separate round's bug fix. There is exactly one
// copy, and it is a PURE function of plain data:
//
//   * no DOM, no `window`, no module-level mutable state;
//   * everything a node cannot answer about itself (its drawn box, its scene identity, its type leaf, the build's
//     view-scale stamps, the levers) arrives through {@link TipScaleEnv}, which each backend implements over its
//     own registries — the same shape `ViewScaleEnv` / `SpreadEnv` have.
//
// It must NOT import `mirrorRenderer` (that is a cycle): `nodeTypeLeaf` is behind an env method for the same
// reason `viewScaleLayout` takes `leaf` as a parameter.
//
// WHAT EACH BACKEND STILL OWNS. The DOM prepends the matrix onto the tip root's element (re-expressed in its
// parent's space, because CSS nests) and keeps its geometry-epoch gate; the canvas threads it down the draw-list
// walk as part of the accumulated stamp product. Both compose it the same way — OUTSIDE the tip's own placement
// and INSIDE any enclosing view-scale stamp — which is what makes a tooltip inside a scaled card-reward group
// land in the same place on both stages.

import type { Affine } from "@/mirror/affine";
import {
  HOVER_TIP_SCALE,
  computeHoverTipScale,
  resolveTipOwnerKind,
  type TipAabb,
  type TipOwnerKind,
  type TipScaleResult
} from "@/mirror/hoverTipScaleMath";
import { nodePaintsContent } from "@/mirror/nodeStyles";
import type { MirrorNode } from "@/mirror/sceneTree";
import {
  mapOwnerThroughViewScaleStamps,
  viewScaleStampMatrix,
  type ViewScaleStampChainEnv
} from "@/mirror/viewScaleLayout";

/**
 * Everything the pass reads that a tip node cannot answer about itself.
 *
 * METHODS, not snapshots — the stamps are rebuilt per drain/build, so an env constructed once per renderer has
 * to re-read them per call (`ViewScaleEnv`'s rule).
 */
export interface TipScaleEnv extends ViewScaleStampChainEnv {
  /** The DESIGN width of this (possibly widened) stage — 1920 × spreadFactor. */
  designW(): number;
  /** The wire node, or undefined for an id this backend is not holding. */
  nodeOf(id: string): MirrorNode | undefined;
  /** `id`'s direct children (any order — the measure unions boxes, and the paint rule is per child). */
  childIdsOf(id: string): readonly string[] | undefined;
  /**
   * The design-space AABB this backend is DRAWING `id` at, BEFORE any tip/view-scale stamp: the node's rendered
   * global (tween overrides included) with its own wide-screen shift folded in. Null when the backend cannot
   * place it — the DOM answers null for a child whose `gDesign` the walk has not cached, and such a child is
   * simply not part of the union.
   */
  drawnBoxOf(id: string): TipAabb | null;
  /** The node-type leaf of `id` (`nodeTypeLeaf(node.nodeType)`) — a parameter to keep this module cycle-free. */
  typeLeafOf(id: string): string | null;
  /** The instanced scene FILE `id` belongs to (the owner-kind fallback for `reward_button.tscn`). */
  sceneFileOf(id: string): string | null;
  /**
   * Leg (iii) of {@link resolveVisualOwnerId}: the topmost interactive rect containing a design-space point, or
   * null. The two backends hit-test different registries (the DOM's `forEachInteractiveRect`, the canvas's hit
   * entries), so the SEARCH is theirs and the RULE is here. `exclude` is the owner itself, which can never
   * stand in for itself.
   */
  hitTestAt(x: number, y: number, exclude: string): string | null;
  /** The design-space ORIGIN of `id` as it is drawn, for the leg-(iii) probe. Null when unplaceable. */
  originOf(id: string): { x: number; y: number } | null;
}

/** One tip's applied enlargement: the pivot/clamp result, and the design-space matrix that expresses it. */
export interface TipScaleStamp {
  /** The enlargement factor — always {@link HOVER_TIP_SCALE}; carried so a consumer need not re-import it. */
  k: number;
  result: TipScaleResult;
  /** `p ↦ P + k·(p − P) + C` as an affine: what a backend LEFT-multiplies the tip subtree's drawn poses by. */
  matrix: Affine;
}

/**
 * The design-space AABBs the tip's enlargement is measured from: its PAINT-BEARING direct children.
 *
 * "Paint-bearing" is a child that paints its own content, OR a content GROUP that has children of its own — a
 * spacer with neither contributes no ink and must not stretch the union (which would move the pivot and, through
 * it, the whole tip). Exported because it is the half a canvas walk measures inline, and a spec pins it.
 */
export function tipChildBoxes(tipId: string, env: TipScaleEnv): TipAabb[] {
  const boxes: TipAabb[] = [];
  const kids = env.childIdsOf(tipId);
  if (!kids) {
    return boxes;
  }
  for (const cid of kids) {
    const cn = env.nodeOf(cid);
    if (!cn || !cn.visible || cn.localRect == null) {
      continue;
    }
    const modAlpha = cn.modulate ? cn.modulate.a : cn.opacity;
    const selfAlpha = cn.selfModulate ? cn.selfModulate.a : 1;
    const childHasKids = (env.childIdsOf(cid)?.length ?? 0) > 0;
    if (!nodePaintsContent(cn, modAlpha * selfAlpha) && !childHasKids) {
      continue;
    }
    const box = env.drawnBoxOf(cid);
    if (box !== null) {
      boxes.push(box);
    }
  }
  return boxes;
}

/**
 * THE ON-SCREEN THING A TIP POINTS AT (R5 H2 — twin of native `TipOwnerResolve.ResolveVisualOwnerId`), moved here
 * from the DOM renderer so both stages resolve the SAME node.
 *
 *   (i)   the owner has a positive-width box → itself;
 *   (ii)  a 0×0 anchor (an `NHandCardHolder`) → its first PAINTING descendant with a positive box, in walk order;
 *   (iii) none → hit-test the owner's own origin (the topmost painter under it stands in);
 *   (iv)  → the owner id verbatim.
 *
 * LEG (ii) IS WHY THIS IS SHARED RATHER THAN RESTATED, measured on `wscrisp-hovertip`: the canvas backend had its
 * own "first visible descendant with a positive width" walk for the spread's floater `ownerDx`, which is a
 * DIFFERENT question — no paint test, and over the z-SORTED paint order. On the hand-card holder that recording
 * hovers, that walk answers a fully transparent 370x708 aura `TextureRect` (`modulate` alpha 0) where this rule
 * answers the 300x422 `NCardHolderHitbox`, and the two owner boxes put the side clamp 12 design px apart — a
 * tooltip drawn in a different place on the two stages, with nothing in either arm's own tests to show it.
 */
export function resolveVisualOwnerId(ownerId: string, env: TipScaleEnv): string {
  const owner = env.nodeOf(ownerId);
  if (!owner) {
    return ownerId;
  }
  if (owner.localRect != null && owner.localRect.width > 0) {
    return ownerId;
  }
  const painting = firstPaintingDescendant(ownerId, env);
  if (painting != null) {
    return painting;
  }
  const origin = env.originOf(ownerId);
  return (origin && env.hitTestAt(origin.x, origin.y, ownerId)) ?? ownerId;
}

/** Walk-order pre-order search for the first PAINTING descendant with a positive-width box (leg (ii)). */
function firstPaintingDescendant(rootId: string, env: TipScaleEnv): string | null {
  const kids = env.childIdsOf(rootId);
  if (!kids) {
    return null;
  }
  for (const cid of kids) {
    const cn = env.nodeOf(cid);
    if (cn != null && cn.visible && cn.localRect != null && cn.localRect.width > 0) {
      const modAlpha = cn.modulate ? cn.modulate.a : cn.opacity;
      const selfAlpha = cn.selfModulate ? cn.selfModulate.a : 1;
      if (nodePaintsContent(cn, modAlpha * selfAlpha)) {
        return cid;
      }
    }
    const deep = firstPaintingDescendant(cid, env);
    if (deep != null) {
      return deep;
    }
  }
  return null;
}

/** The tip's anchor owner as the pivot math wants it: its kind, its drawn box, and the view-scale follow. */
interface TipOwner {
  kind: TipOwnerKind;
  box: TipAabb | null;
  followX: number;
  followY: number;
}

const NO_OWNER: TipOwner = { kind: "none", box: null, followX: 0, followY: 0 };

/**
 * Resolve what the tip points at.
 *
 * The KIND is keyed on the ORIGINAL anchor owner (a holder is still a "hand card"), never on the resolved visual
 * owner; the BOX is the visual owner's, since that is the ink the tip must not cover. R5/R6 item 6: if the owner
 * renders inside view-scaled item(s), its box is forward-mapped through every containing stamp (group ∘ card) and
 * the centre delta becomes a FOLLOW translation, so the tip stays glued to where the owner is actually drawn.
 */
function resolveTipOwner(tipNode: MirrorNode, env: TipScaleEnv): TipOwner {
  const rawOwnerId = tipNode.anchorOwnerId;
  if (rawOwnerId == null) {
    return NO_OWNER;
  }
  const rawOwnerNode = env.nodeOf(rawOwnerId);
  const kind = rawOwnerNode
    ? resolveTipOwnerKind(env.typeLeafOf(rawOwnerId), env.sceneFileOf(rawOwnerId))
    : resolveTipOwnerKind(null, null);
  // R5 H2: measure the VISUAL owner (a 0×0 holder → its painting card child), not the anchor node itself.
  const ownerId = resolveVisualOwnerId(rawOwnerId, env);
  const raw = env.drawnBoxOf(ownerId);
  if (raw === null) {
    return { kind, box: null, followX: 0, followY: 0 };
  }
  const mapped = mapOwnerThroughViewScaleStamps(ownerId, raw, env);
  if (mapped === null) {
    return { kind, box: raw, followX: 0, followY: 0 };
  }
  return {
    kind,
    box: mapped,
    followX: mapped.x + mapped.w / 2 - (raw.x + raw.w / 2),
    followY: mapped.y + mapped.h / 2 - (raw.y + raw.h / 2)
  };
}

/**
 * The whole answer for ONE tip-set root: measure, resolve the owner, pick pivot + clamp, build the matrix.
 *
 * Null means "do not stamp this tip" — no tip node, or no paint-bearing child to measure (a tip that is on screen
 * but has drawn nothing yet, which must be left at 1.0 rather than scaled about a degenerate union).
 */
export function computeTipScaleStamp(tipId: string, env: TipScaleEnv): TipScaleStamp | null {
  const tipNode = env.nodeOf(tipId);
  if (!tipNode) {
    return null;
  }
  const boxes = tipChildBoxes(tipId, env);
  if (boxes.length === 0) {
    return null;
  }
  const owner = resolveTipOwner(tipNode, env);
  const result = computeHoverTipScale(
    boxes,
    env.designW(),
    owner.box,
    owner.kind,
    owner.followX,
    owner.followY
  );
  if (result === null) {
    return null;
  }
  // The SAME matrix construction the view scale uses (`P + k·(p − P) + C` as an affine) — one spelling of the
  // stamp algebra, so the two families compose predictably where they nest.
  return { k: HOVER_TIP_SCALE, result, matrix: viewScaleStampMatrix(HOVER_TIP_SCALE, result) };
}
