// THE VIEW-SCALE LAYOUT ALGEBRA — one copy, shared by both mirror backends.
//
// `viewScale.ts` owns the TABLE (which scene identities are enlarged, by how much, about which anchor).
// `hoverTipScaleMath.ts` owns the per-anchor scale/clamp GEOMETRY. `viewScaleInverse.ts` owns the pointer
// INVERSE. This module is the LAYOUT step between them: given a node, decide whether it is a view-scale item at
// all, measure the box its stamp is computed from, turn that into the design-space stamp matrix a backend
// prepends, and fold the published stamps into the GAME-space input registry the inverse consumes.
//
// WHY IT LIVES HERE. All of it used to live inside `mirrorRenderer` — the registration branch closed over the
// DOM walk's `ctx`, and `applyViewScalePass` / `buildViewScaleInputStamps` closed over its records, its
// `nodes` map and its module-level levers. The canvas backend (`canvas/buildDrawList.ts`) has to enlarge the
// SAME items by the SAME factors about the SAME anchors or the two stages disagree about where a tappable
// widget is: the shop carpet, the map legend, the card-reward row and the combat pile buttons are all
// view-scale items, and a stage that skips them paints them 1.1–1.265x too small AND answers taps at the wrong
// place. Two transcriptions of a table-driven pass with this many special cases could not stay in step, so
// there is exactly one, and — like `spreadLayout` beside it — it is a PURE function of plain data:
//
//   * no DOM, no `window`, no module-level mutable state;
//   * the parts it cannot derive from a node (scene identity, the URL levers, the walk's paint order, the
//     ancestor chains) arrive through {@link ViewScaleEnv} / {@link ViewScaleRegistryEnv}, which each backend
//     implements over its own registries.
//
// It also MUST NOT import `mirrorRenderer` (that is a cycle): the node-type `leaf` is a PARAMETER, because both
// walks already compute `nodeTypeLeaf(node.nodeType)` for their own reasons.
//
// NATIVE PRIOR ART, and the rule it comes with. The host's own twin is a pure per-drain `ViewScaleStampIndex`
// built from scratch each time (see `docs/agents/architecture-map.md` — "R8 — do not re-introduce state here":
// a stateful stamp index caused the event-option snap-back three rounds running). This module keeps that shape:
// {@link ViewScaleStampIndex} is a per-build index, and nothing here remembers a previous one.

import { affineMul, IDENTITY_AFFINE, nodeMatrix, type Affine } from "@/mirror/affine";
import {
  boxFullyOutsideDesign,
  computeAnchoredScaleStamp,
  type TipAabb,
  type TipScaleResult
} from "@/mirror/hoverTipScaleMath";
import type { MirrorNode, MirrorRect } from "@/mirror/sceneTree";
import {
  CARD_REWARD_CARD_RESOLVED,
  CARD_REWARD_GROUP_RESOLVED,
  CARD_REWARD_SCREEN_LEAF,
  TREASURE_RELIC_LEAF,
  TREASURE_RELIC_RESOLVED,
  VIEW_SCALE_CANDIDATE_NAMES,
  VIEW_SCALE_ROOT_FILES,
  resolveViewScale,
  viewScaleActive,
  type ViewScaleResolved
} from "@/mirror/viewScale";
import {
  aabbEncloses,
  aabbIsStageBand,
  aabbOverlaps,
  type ViewScaleAabb,
  type ViewScaleInputStamp
} from "@/mirror/viewScaleInverse";

/**
 * The nominal card box a 0x0 `NCard` root is measured with (design px).
 *
 * A card-reward `NCard` streams no box of its own — its painted art lives in descendants, and the native
 * `MeasureBox` unions the subtree. The card's paint-union CENTRE is within ~1px of the `NCard`'s design origin,
 * and a `noClamp` centre scale depends ONLY on the box centre, so a nominal card-sized box about that origin
 * gives the correct visual stamp (the SIZE only feeds the tip-follow forward-map).
 */
export const VIEW_SCALE_NOMINAL_CARD_W = 240;
export const VIEW_SCALE_NOMINAL_CARD_H = 338;

/**
 * The scene-identity + enablement half of the view-scale environment — answers a node's own fields cannot give.
 *
 * METHODS, not snapshots: an env built once per renderer must re-read the current viewer setting on every call
 * (this is the same shape `spreadSceneIdentityEnv` has).
 */
export interface ViewScaleEnv {
  /** False when the viewer has disabled readability scaling, so no node is a view-scale item. */
  enabled(): boolean;
  /** The instanced `.tscn` a node belongs to and its path relative to that scene root (`computeSceneInfo`). */
  sceneOf(id: string): { file: string; relPath: string } | null;
}

/** One applied view-scale stamp, as a backend publishes it for the tip pass + the input registry. */
export interface ViewScaleStamp {
  pivotX: number;
  pivotY: number;
  /** The enlargement factor (1.0 for a translate-only entry — the ancient-event dialogue lift). */
  k: number;
  offsetX: number;
  offsetY: number;
  /** The item's PRE-scale box in WIDENED-DESIGN space (i.e. spread shift already folded in). */
  box: TipAabb;
  /** That item's cumulative wide-screen shift, so the registry can express the stamp in GAME (1920) space. */
  spreadDx: number;
  isGroup: boolean;
}

/**
 * A build's whole view-scale answer: id → stamp, in the order the walk stamped them.
 *
 * INSERTION ORDER IS LOAD-BEARING. {@link buildViewScaleInputRegistry} iterates this map and pushes one input
 * stamp per surviving entry, and `viewScaleInverse.claimViewScaleStamp` walks the published array BACKWARDS
 * ("topmost-first"). So the map's iteration order IS the input side's z-order, and a backend must fill it in
 * paint order.
 */
export type ViewScaleStampIndex = Map<string, ViewScaleStamp>;

/**
 * Does this node-type leaf open the card-reward SELECTION screen?
 *
 * The card-reward rules are the one family detected by node-type LEAF rather than by the table: the screen root
 * carries the 1.10 whole-screen GROUP, and every `NCard` UNDER it carries the per-card 1.15. Both walks thread
 * an `inCardRewardScreen` ancestry flag for the second half, and this is the predicate that sets it.
 */
export function opensCardRewardScreen(leaf: string): boolean {
  return leaf === CARD_REWARD_SCREEN_LEAF;
}

/**
 * Is this node a view-scale item, and which entry does it resolve to? Null = not scaled (the overwhelming case).
 *
 * The exact branch order of `mirrorRenderer`'s registration site, moved verbatim — and the order is the
 * behaviour. The cheap PRE-FILTER runs first (own `sceneFilePath` is a view-scale ROOT file, or the node NAME is
 * a known non-root container), and a node that passes it takes the TABLE branch even when the table then
 * answers neutral. That is why `viewScale.VIEW_SCALE_ROOT_FILES` deliberately omits `map_screen.tscn`,
 * `rewards_screen.tscn`, `deck_view_screen.tscn`, `inspect_card_screen.tscn` and the treasure relic holder: each
 * of those has a rule that fires on a CHILD or on a node-type leaf, and listing the root file here would send
 * the root down the table branch and SHADOW the branch that actually stamps it. See the header comment on
 * `VIEW_SCALE_ROOT_FILES` — the absences are deliberate; do not "fix" them.
 *
 * `leaf` is `nodeTypeLeaf(node.nodeType)`, computed by the caller's walk (this module must not import the
 * renderer). `inCardRewardScreen` is the ancestry flag {@link opensCardRewardScreen} sets.
 */
export function resolveViewScaleForNode(
  id: string,
  node: MirrorNode,
  leaf: string,
  inCardRewardScreen: boolean,
  env: ViewScaleEnv
): ViewScaleResolved | null {
  if (!env.enabled() || !node.visible) {
    return null;
  }
  let res: ViewScaleResolved | null = null;
  if (VIEW_SCALE_ROOT_FILES.has(node.sceneFilePath ?? "") || VIEW_SCALE_CANDIDATE_NAMES.has(node.name ?? "")) {
    const scene = env.sceneOf(id);
    res = scene ? resolveViewScale(scene.file, scene.relPath) : null;
  } else if (leaf === CARD_REWARD_SCREEN_LEAF) {
    res = CARD_REWARD_GROUP_RESOLVED;
  } else if (inCardRewardScreen && leaf === "NCard") {
    res = CARD_REWARD_CARD_RESOLVED;
  } else if (leaf === TREASURE_RELIC_LEAF) {
    // The treasure-room relic HOLDER — leaf-detected for the same reason as the card-reward screen (its
    // scene-relative path is truncated by the instanced relic/vote sub-scenes, and the vote container's own
    // scene is reused by the map points + the ProceedButton). Its co-op vote icons are children, so they ride
    // this stamp.
    res = TREASURE_RELIC_RESOLVED;
  }
  // A translate-only entry (scale 1) still counts as active; a neutral resolve does not.
  return res && viewScaleActive(res) ? res : null;
}

/**
 * The design-space axis-aligned bounding box of a node with rendered global `g` and node-local box `lr`.
 *
 * The box renders at local (0,0)-(w,h) under `nodeMatrix(g, lr)`; transform the four corners and take the
 * extents, so a rotated or skewed item measures its true envelope. (`mirrorRenderer.designAabb`, moved.)
 */
export function designAabbOf(g: readonly number[], lr: MirrorRect): TipAabb {
  const w = lr.width;
  const h = lr.height;
  const m = nodeMatrix(g, lr);
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
  const xs = [e, a * w + e, c * h + e, a * w + c * h + e];
  const ys = [f, b * w + f, d * h + f, b * w + d * h + f];
  const minX = Math.min(xs[0], xs[1], xs[2], xs[3]);
  const maxX = Math.max(xs[0], xs[1], xs[2], xs[3]);
  const minY = Math.min(ys[0], ys[1], ys[2], ys[3]);
  const maxY = Math.max(ys[0], ys[1], ys[2], ys[3]);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The nominal card box about a design origin — see {@link VIEW_SCALE_NOMINAL_CARD_W}. */
export function viewScaleNominalBox(cx: number, cy: number): TipAabb {
  return {
    x: cx - VIEW_SCALE_NOMINAL_CARD_W / 2,
    y: cy - VIEW_SCALE_NOMINAL_CARD_H / 2,
    w: VIEW_SCALE_NOMINAL_CARD_W,
    h: VIEW_SCALE_NOMINAL_CARD_H
  };
}

/**
 * The stamp for one measured box, or null when the item must NOT be stamped.
 *
 * Two rejections, both of them load-bearing:
 *
 *   * OFF-STAGE (the P4 "shop phantom"). `node.visible` only proves the flag is set, not that the box is on
 *     stage — the closed shop parks its `SlotsContainer` at local y≈−1000 while still Visible. A box with NO
 *     overlap at all with the design rect is rejected BEFORE a stamp exists, because the stamp's own on-screen
 *     clamp would otherwise drag the parked box wholly into view. A box only PARTIALLY off-screen still stamps;
 *     the clamp is the right answer there.
 *   * DEGENERATE. A 0-area box has no centre to scale about (`computeAnchoredScaleStamp` returns null).
 */
export function computeViewScaleStamp(box: TipAabb, entry: ViewScaleResolved, designW: number): TipScaleResult | null {
  if (boxFullyOutsideDesign(box, designW)) {
    return null;
  }
  return computeAnchoredScaleStamp(
    box,
    entry.scale,
    designW,
    undefined,
    entry.pivot,
    entry.translateX,
    entry.translateY,
    entry.noClamp
  );
}

/**
 * The DESIGN-space stamp matrix: scale by `k` about the stamp's anchor pivot, then translate by its offset
 * (requested translate + on-screen clamp). At `k === 1` this is a pure translate.
 *
 * `p ↦ P + k·(p − P) + C` written as an affine — the exact forward map `viewScaleInverse` inverts.
 */
export function viewScaleStampMatrix(k: number, res: TipScaleResult): Affine {
  return [k, 0, 0, k, res.pivotX * (1 - k) + res.offsetX, res.pivotY * (1 - k) + res.offsetY];
}

// --- forward-mapping a box through the stamps that render it -------------------------------------------------

/**
 * The ancestry + stamp lookup {@link mapOwnerThroughViewScaleStamps} walks. Each backend answers it over its own
 * node map and its own copy of THIS BUILD's stamps (the DOM's `viewScaleStamps`, the canvas walk's index).
 */
export interface ViewScaleStampChainEnv {
  parentIdOf(id: string): string | null | undefined;
  stampOf(id: string): ViewScaleStamp | undefined;
}

/**
 * Forward-map a design box through ONE view-scale stamp (scale about its pivot, then its clamp offset) — twin of
 * native `ViewScaler.MapThroughStamp`.
 */
export function mapThroughViewScaleStamp(
  box: TipAabb,
  s: { pivotX: number; pivotY: number; k: number; offsetX: number; offsetY: number }
): TipAabb {
  const minX = s.pivotX + s.k * (box.x - s.pivotX) + s.offsetX;
  const minY = s.pivotY + s.k * (box.y - s.pivotY) + s.offsetY;
  const maxX = s.pivotX + s.k * (box.x + box.w - s.pivotX) + s.offsetX;
  const maxY = s.pivotY + s.k * (box.y + box.h - s.pivotY) + s.offsetY;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * R6 (WS-TIP): forward-map a box through EVERY stamp that renders it — the node's OWN stamp AND every stamped
 * ANCESTOR — composed innermost→outermost (group ∘ card), so a tip glued to an off-centre card inside a scaled
 * GROUP follows the group's displacement (twin of native `ViewScaler.MapThroughContainingStamps`). R5 shipped only
 * the single topmost/exact stamp, which for the card-reward per-card 1.15 (Center + NoClamp ⇒ centre-fixed) gave a
 * ZERO follow.
 *
 * Selection is ANCESTRY-only — hierarchy-faithful, robust to nesting, and (unlike the R5 box-containment fallback)
 * it never spuriously maps a non-scaled overlay whose centre merely lands inside a full-viewport group box.
 * Returns the composed box, or null when no stamp covers it at all (the caller's "no follow" answer).
 */
export function mapOwnerThroughViewScaleStamps(
  ownerId: string,
  ownerBox: TipAabb,
  env: ViewScaleStampChainEnv
): TipAabb | null {
  let mapped = ownerBox;
  let any = false;
  for (let cur: string | null | undefined = ownerId; cur != null; cur = env.parentIdOf(cur)) {
    const s = env.stampOf(cur);
    if (s) {
      mapped = mapThroughViewScaleStamp(mapped, s);
      any = true; // at most one stamp per node
    }
  }
  return any ? mapped : null;
}

// --- the GAME-space input registry -------------------------------------------------------------------------

/** One interactive rect as the registry reads it — the shared subset of both backends' `InteractiveRect`. */
export interface ViewScaleRegistryRect {
  id: string;
  /** The rect's TRUE game-space global (no spread shift) — `InteractiveRect.transform`. */
  transform: readonly number[];
  localRect: MirrorRect;
}

/**
 * The tree + order questions the registry asks, over whichever map the backend is walking.
 *
 * `orderedIds` is a GETTER on purpose: the DOM backend re-points it at `state.orderedIds` on every walk, and a
 * snapshot taken when the env was constructed would go stale after the first delta.
 */
export interface ViewScaleRegistryEnv {
  /** `id`'s parent id — `null`/`undefined` for a root or an id the backend does not hold. */
  parentIdOf(id: string): string | null | undefined;
  /** The walk's flat paint order, back-to-front (the same array the interactive rects were folded from). */
  readonly orderedIds: readonly string[];
  /**
   * Does `id` have an INVISIBLE ancestor? An id the backend does not hold answers FALSE — i.e. it is KEPT.
   * (The DOM twin reads `records.get(id)?.lastNode` and only tests the predicate when a record exists.)
   */
  ancestorChainHidden(id: string): boolean;
  /** The 1920 design width the rule-3 stage-band test measures against (never the widened stage width). */
  designWidth: number;
}

/**
 * Fold this build's stamps into the GAME-space input registry `viewScaleInverse.remapViewScaleInverse` consumes.
 *
 * Each stamp is expressed in GAME (1920) space by subtracting the item's spread shift from X — the clamp offset
 * and everything on Y carry unchanged, because the applied on-screen clamp IS what the visual displacement
 * folded, so inverting with the SAME offset is exact and Y is never spread.
 *
 * For each stamp it composes its own channel with every stamped ancestor, then collects the interactive rects that
 * overlap the fully enlarged box, sit outside every stamped subtree, and survive four neighbour rules:
 *
 *   1. not a strict ANCESTOR of the stamped node;
 *   2. not a rect that ENCLOSES the item's pre-scale box (a backdrop cannot speak for a widget inside it);
 *   3. not a full-stage BAND (≥95% of the design width);
 *   4. the Z-RULE — not painted BELOW the stamp's paint floor. A rect painted under the enlarged item is
 *      invisible under it, so it can never own a tap there; a legitimate overlay paints AFTER it. For a GROUP
 *      the floor is {@link groupPaintFloor}; for an ITEM (since R19) it is the item's own paint index. A rect
 *      MISSING from the paint order is KEPT, exactly like native's `TryGetValue` arm.
 *
 * Native twin, kept in lockstep: `ViewScaleInputRegistry.Build` / `.DroppedByFilter` / `.GroupPaintFloor`.
 */
export function buildViewScaleInputRegistry(
  stamps: ViewScaleStampIndex,
  rects: readonly ViewScaleRegistryRect[],
  env: ViewScaleRegistryEnv
): ViewScaleInputStamp[] {
  const out: ViewScaleInputStamp[] = [];
  if (stamps.size === 0) {
    return out;
  }
  const stampedIds = new Set(stamps.keys());
  // Fold each interactive rect to its GAME-space AABB once (its transform is the true 1920-space global).
  const rectBoxes: { id: string; box: ViewScaleAabb }[] = [];
  for (const r of rects) {
    const a = designAabbOf(r.transform, r.localRect);
    rectBoxes.push({ id: r.id, box: { minX: a.x, minY: a.y, maxX: a.x + a.w, maxY: a.y + a.h } });
  }
  // Paint-index lookup for rule 4 — built once whenever a stamp is published. Native twin: `BuildOrderIndex`.
  const orderIndex = buildPaintOrderIndex(env.orderedIds);
  for (const [id, s] of stamps) {
    // EFFECTIVE VISIBILITY. A SCREEN is hidden by clearing the flag on its ROOT, so every descendant keeps
    // `visible: true` and the stamp pass (which tests the node's OWN flag) happily stamps it. That is right for
    // the VISUAL — the item paints nothing anyway — but THIS registry is coordinate-only, so a closed map screen
    // would otherwise keep claiming pointers in combat (measured: ~67 design px of instantaneous cursor jump).
    if (env.ancestorChainHidden(id)) {
      continue;
    }
    // Rule 4's paint floor for this stamp. −∞ means the stamp has no paint index, so an unknown rect stays kept.
    const groupFloor =
      s.isGroup
        ? groupPaintFloor(id, stampedIds, orderIndex, env)
        : orderIndex.get(id) ?? -Infinity;
    const dx = s.spreadDx;
    const composed = composeInputChannel(id, s, stamps, env);
    const channel = composed.channel;
    const originalBox: ViewScaleAabb = {
      minX: s.box.x - dx,
      minY: s.box.y,
      maxX: s.box.x + s.box.w - dx,
      maxY: s.box.y + s.box.h
    };
    const ownUnscaledBox = mapAabbThroughAffine(originalBox, composed.ancestorGame);
    const scaledBox = mapAabbThroughAffine(originalBox, composed.game);
    // Keep the fully-composed widened-design box, rather than recovering it from a leaf dx. That is the one point
    // where an ancestor's widened-stage channel must retain its `(k - 1) * dx` contribution.
    const renderedBox = mapAabbThroughAffine(
      { minX: s.box.x, minY: s.box.y, maxX: s.box.x + s.box.w, maxY: s.box.y + s.box.h },
      composed.wide
    );
    const neighborRects: ViewScaleAabb[] = [];
    for (const rb of rectBoxes) {
      if (!aabbOverlaps(rb.box, scaledBox) || inStampedSubtree(rb.id, stampedIds, env)) {
        continue; // outside the halo, or a child of a scaled subtree (rides the stamp's own inverse)
      }
      if (
        isStrictAncestor(rb.id, id, env) ||
        aabbEncloses(rb.box, originalBox) ||
        aabbIsStageBand(rb.box, env.designWidth)
      ) {
        continue; // rules 1/2/3: an ancestor / an enclosing backdrop / a full-stage band is never a neighbour
      }
      const ri = orderIndex.get(rb.id);
      if (ri !== undefined && ri < groupFloor) {
        continue; // rule 4: painted under the stamp ⇒ hidden under it ⇒ it can never own a tap there
      }
      neighborRects.push(rb.box);
    }
    out.push({ channel, scaledBox, originalBox, ownUnscaledBox, isGroup: s.isGroup, neighborRects, renderedBox });
  }
  return out;
}

/** A uniform view-scale stamp expressed as a widened-design affine. */
function stampAffine(s: ViewScaleStamp): Affine {
  return [s.k, 0, 0, s.k, s.pivotX * (1 - s.k) + s.offsetX, s.pivotY * (1 - s.k) + s.offsetY];
}

function shiftX(dx: number): Affine {
  return dx === 0 ? IDENTITY_AFFINE : [1, 0, 0, 1, dx, 0];
}

function mapAabbThroughAffine(box: ViewScaleAabb, m: Affine): ViewScaleAabb {
  // View-scale channels are uniform scales + translates today. Keeping this four-corner fold makes the registry
  // remain correct if an enclosing cosmetic channel acquires an affine linear part later.
  const xs = [
    m[0] * box.minX + m[2] * box.minY + m[4],
    m[0] * box.maxX + m[2] * box.minY + m[4],
    m[0] * box.minX + m[2] * box.maxY + m[4],
    m[0] * box.maxX + m[2] * box.maxY + m[4]
  ];
  const ys = [
    m[1] * box.minX + m[3] * box.minY + m[5],
    m[1] * box.maxX + m[3] * box.minY + m[5],
    m[1] * box.minX + m[3] * box.maxY + m[5],
    m[1] * box.maxX + m[3] * box.maxY + m[5]
  ];
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/**
 * Compose the full ancestor→leaf visual channel in widened-design space, then bridge it into the leaf's GAME
 * coordinates. The bridge is deliberately OUTSIDE the product: folding each stamp after subtracting its own spread
 * shift loses an enclosing scale's `(k - 1) * dx` displacement on a widened stage.
 */
function composeInputChannel(
  id: string,
  leaf: ViewScaleStamp,
  stamps: ViewScaleStampIndex,
  env: ViewScaleRegistryEnv
): { wide: Affine; game: Affine; ancestorGame: Affine; channel: ViewScaleInputStamp["channel"] } {
  const chain: ViewScaleStamp[] = [];
  for (let cur: string | null | undefined = id; cur != null; cur = env.parentIdOf(cur)) {
    const s = stamps.get(cur);
    if (s) chain.unshift(s);
  }
  let wide = IDENTITY_AFFINE;
  let ancestorWide = IDENTITY_AFFINE;
  for (let i = 0; i < chain.length; i++) {
    if (i + 1 < chain.length) ancestorWide = affineMul(ancestorWide, stampAffine(chain[i]));
    wide = affineMul(wide, stampAffine(chain[i]));
  }
  const dx = leaf.spreadDx;
  const game = affineMul(shiftX(-dx), affineMul(wide, shiftX(dx)));
  const ancestorGame = affineMul(shiftX(-dx), affineMul(ancestorWide, shiftX(dx)));
  // Preserve the leaf pivot in the public channel so a top-level stamp remains byte-for-byte shaped as before;
  // derive its clamp from the composed affine. `viewScaleInverseMapPoint` only observes this equivalent form.
  const pivotX = leaf.pivotX - dx;
  const pivotY = leaf.pivotY;
  const k = game[0];
  return {
    wide,
    game,
    ancestorGame,
    channel: {
      pivotX,
      pivotY,
      k,
      offsetX: game[4] - pivotX * (1 - k),
      offsetY: game[5] - pivotY * (1 - k)
    }
  };
}

/** `id` or any ancestor is a stamped node → its interactive rect belongs to a scaled subtree, not a neighbour. */
function inStampedSubtree(id: string, stampedIds: ReadonlySet<string>, env: ViewScaleRegistryEnv): boolean {
  for (let cur: string | null | undefined = id; cur != null; cur = env.parentIdOf(cur)) {
    if (stampedIds.has(cur)) {
      return true;
    }
  }
  return false;
}

/** `maybeAncestorId` is a STRICT ancestor of `nodeId` (walks `nodeId`'s parents up, excludes self). */
function isStrictAncestor(maybeAncestorId: string, nodeId: string, env: ViewScaleRegistryEnv): boolean {
  for (let cur = env.parentIdOf(nodeId); cur != null; cur = env.parentIdOf(cur)) {
    if (cur === maybeAncestorId) {
      return true;
    }
  }
  return false;
}

/** `id` IS `ancestorId` or descends from it — the rule-4 contiguity probe's membership test. */
function descendsFrom(id: string, ancestorId: string, env: ViewScaleRegistryEnv): boolean {
  for (let cur: string | null | undefined = id; cur != null; cur = env.parentIdOf(cur)) {
    if (cur === ancestorId) {
      return true;
    }
  }
  return false;
}

/**
 * id → paint index over the flat order, back-to-front. A DUPLICATED id keeps its LAST index, like native's
 * `BuildOrderIndex` — the later paint is the one a finger would land on.
 */
function buildPaintOrderIndex(orderedIds: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < orderedIds.length; i++) {
    map.set(orderedIds[i], i);
  }
  return map;
}

/**
 * The paint index below which a rect counts as "under" a GROUP — twin of `ViewScaleInputRegistry.GroupPaintFloor`
 * (kept structurally identical, contiguity fallback included, so the two clients drop the same underlays).
 *
 * Normally the group ROOT's own index: its descendants paint above it, a legitimate overlay paints after the
 * whole subtree, and a candidate is never a descendant (`inStampedSubtree` already excluded the group's
 * subtree). DEFENSIVE fallback: when the group's stamped subtree is NOT contiguous in paint order (a foreign
 * node interleaves between the root and a stamped descendant — a non-DFS order), raise the floor to the max
 * stamped-subtree index so an interleaved underlay is still dropped.
 */
function groupPaintFloor(
  groupId: string,
  stampedIds: ReadonlySet<string>,
  orderIndex: Map<string, number>,
  env: ViewScaleRegistryEnv
): number {
  const rootIdx = orderIndex.get(groupId);
  if (rootIdx === undefined) {
    return -Infinity; // the group root isn't painted → nothing is "under" it
  }
  const orderedIds = env.orderedIds;
  let subtreeMax = rootIdx;
  for (const sid of stampedIds) {
    if (sid === groupId) {
      continue;
    }
    const si = orderIndex.get(sid);
    if (si === undefined || si <= rootIdx) {
      continue;
    }
    if (descendsFrom(sid, groupId, env)) {
      subtreeMax = Math.max(subtreeMax, si);
    }
  }
  if (subtreeMax === rootIdx) {
    return rootIdx; // no stamped descendants → the floor is the root's own index
  }
  for (let i = rootIdx + 1; i <= subtreeMax && i < orderedIds.length; i++) {
    if (!descendsFrom(orderedIds[i], groupId, env)) {
      return subtreeMax; // contiguity violated → raise the floor to catch an interleaved underlay
    }
  }
  return rootIdx;
}
