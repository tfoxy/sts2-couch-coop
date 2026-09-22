// THE CREATURE PLACEHOLDER — stand-in art for a creature whose Spine rig is slow, failed, or never requested.
//
// A creature in the mirror is drawn ENTIRELY from a host-baked raster still (`GET /spines/…&still=1`). Until that
// still lands the creature's box is empty: the viewer sees a health bar, an intent row and a selection reticle
// wrapped around nothing at all. Three situations produce that, and this module covers all three with one image:
//
//   * a SLOW first bake — the host bakes per (rig, anim), so a cold room entry is a real wait;
//   * a FAILED bake — `requestAnimatedClip`'s rejection path leaves the node blank forever;
//   * `?quality=off` (and the `?debug` auto-player / a software-WebGL phone) — the off tier requests no clip at
//     all, so nothing is ever coming.
//
// The stand-in is the game's own `the_adversary_placeholder.png`, STRETCHED to fill the creature's box exactly.
//
// ---------------------------------------------------------------------------------------------------------------
// WHY ONLY TWO RIGS, AND WHY THEY ARE NAMED RATHER THAN DETECTED
//
// "Stretch it into the creature's box" presupposes a box, and only some rigs have one on the wire:
//
//   COMBAT CREATURE   res://scenes/creature_visuals/*.tscn, spine node `Visuals`. The game RE-SIZES the box per
//                     rig at runtime and streams it three times over — `Hitbox` and `SelectionReticle` under the
//                     `combat/creature.tscn` root, and `Bounds` beside the spine node — so it is exact and it is
//                     per-creature (Ironclad 242x278, Sludge Spinner 192x246).
//   SHOP MERCHANT     res://scenes/rooms/merchant_room.tscn, spine node
//                     `SceneContainer/MerchantButton/MerchantVisual`. The box is the button's own 270x330 rect
//                     (the merchant's selection reticle mirrors it).
//
// Everything else is deliberately OUT, because inventing a box would be worse than painting nothing:
//
//   * the shop's PLAYER characters (`merchant/characters/*.tscn`) are a bare `SpineSprite` with no bounds node of
//     any kind — there is nothing to stretch into;
//   * a room BACKGROUND spine (`merchant_room.tscn → SceneContainer/BgContainer/SpineSprite`) is scenery, and a
//     200x200 knight stretched over a whole room is not a placeholder, it is a bug;
//   * the merchant's card-fan rig (`merchant_inventory.tscn → MerchantHandContainer`) is not a creature;
//   * a rig's SECONDARY spine nodes (a weapon, a rock, a second body segment) share the creature's one box, so
//     admitting them would stack N copies of the same image — hence the `Visuals` leaf test.
//
// Six `creature_visuals` scenes draw their creature with a plain `Sprite2D` instead of a Spine rig. Those paint
// through the ordinary texture path and were never blank, so they need nothing here and get nothing.
//
// ---------------------------------------------------------------------------------------------------------------
// THE BOX IS NOT AT THE NODE ORIGIN — read this before "simplifying" the algebra away
//
// A spine node's origin is NOT where its art is drawn. The merchant's `MerchantVisual` sits at (-1122.7, -396.68)
// relative to a button whose rect starts at (1206, 468); the art lands back inside the button only because the
// baked clip's own `localX/localY` header pushes it there. So the placeholder has to be positioned FROM THE BOX
// NODE, re-expressed in the spine node's local space — never from the spine node's origin with an assumed extent.
//
// ---------------------------------------------------------------------------------------------------------------
// ONE POLICY, TWO BACKENDS — the `raise/creatureHud.ts` rule. The DOM backend (`renderer/dom/spineLayerController`)
// and the canvas backend (`canvas/overlay`) both mount an `<img>` for a spine still already, and they mount this
// one the same way. The decision of WHETHER and WHERE lives here so the two cannot disagree about it.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` + `@/render/quality` only.

import { affineInverse, affineMul, nodeMatrix, IDENTITY_AFFINE, type Affine } from "@/mirror/affine";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { CREATURE_SCENE_FILE_SUFFIX } from "@/mirror/raise/constants";
import { isSpineClipNode } from "@/mirror/spineAttributes";
import type { MirrorNode } from "@/mirror/sceneTree";

/** The game's own stand-in art. Served through the mirror's `/res/` seam (see `mirrorResourceUrl`). */
export const CREATURE_PLACEHOLDER_RES = "res://images/monsters/the_adversary_placeholder.png";

/**
 * How long a creature may be blank before the stand-in appears.
 *
 * Not zero: a warm bake answers in well under this, and flashing a placeholder in front of art that was always
 * about to arrive reads as a glitch. Not longer either — a second of an empty reticle is already the whole
 * complaint this exists for.
 */
export const CREATURE_PLACEHOLDER_DELAY_MS = 1000;

/** The DOM class both backends give the stand-in `<img>` (styled once, in MirrorView.vue). */
export const CREATURE_PLACEHOLDER_CLASS = "mirror-spine-placeholder";

/** Which of the two shapes a node is. Exported for the diagnostics seam and the specs. */
export type CreaturePlaceholderKind = "combat-creature" | "shop-merchant";

const CREATURE_VISUALS_SCENE_DIR = "res://scenes/creature_visuals/";
/** The rig's MAIN body node. Two scenes nest it (`CanvasGroup/Visuals`, `ShakeNode/Visuals`), hence the leaf test. */
const CREATURE_VISUALS_SPINE_LEAF = "Visuals";

/**
 * The merchant's spine node, and the scene FILES it has been reached through — matched by file name, not by
 * full path, and that is deliberate.
 *
 * This address has already moved twice. It used to be authored inline in the room, so the producer sent
 * `res://scenes/rooms/merchant_room.tscn` + `SceneContainer/MerchantButton/MerchantVisual` (the form in
 * `.sts2/bench/audit-shop.ndjson`). On game v0.111.0 the button is its own scene, so the same node arrives as
 * `res://scenes/rooms/merchant_button.tscn` + a scene-local `MerchantVisual`. An exact-path match failed
 * silently against the live game — no error, just no stand-in — and a first attempt to fix it guessed the new
 * DIRECTORY (`scenes/merchant/`) wrong and failed silently a second time.
 *
 * So: the node's own LEAF name is the stable half and is matched exactly; the scene is matched on its FILE
 * NAME, which survives the file being re-homed. Both halves still have to agree, so this is far more specific
 * than "any node called MerchantVisual" — and the box resolution below (a parent Control with a real rect) is
 * the third gate. Two scenes named `merchant_button.tscn` in different directories is not a thing STS2 does;
 * a merchant scene moving between `scenes/rooms/` and `scenes/merchant/` demonstrably is.
 */
const MERCHANT_SPINE_LEAF = "MerchantVisual";
const MERCHANT_SCENE_FILES: readonly string[] = ["merchant_button.tscn", "merchant_room.tscn"];

/**
 * The two box nodes a combat creature states its rect on, and where each one lives.
 *
 * `Hitbox` is a child of the `combat/creature.tscn` ROOT and is tried first: it is declared on that scene itself,
 * so every creature has one whatever its visuals scene looks like — including the 3 of 126 rigs whose visuals
 * scene ships no `Bounds`. `Bounds` is the rig's own copy of the same rect and sits BESIDE the spine node, one
 * level down; it is the fallback (and the only answer for a rig rendered outside a creature root at all).
 * `SelectionReticle` carries the identical rect but toggles `visible`, so it is not used.
 */
const CREATURE_ROOT_BOX_NAME = "Hitbox";
const CREATURE_RIG_BOX_NAME = "Bounds";

/** A node index, exactly the shape `raise/creatureHud.ts` takes — the retained map both backends already hold. */
export type NodeMap = ReadonlyMap<string, MirrorNode>;
/** A node's children in wire order. The DOM hands its walk-maintained index; the canvas builds one per pass. */
export type ChildrenOf = (id: string) => readonly string[];

export interface PlaceholderBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Which placeholder shape this node is, or null.
 *
 * INDEX-FREE ON PURPOSE. `nodePaintsContent`, `placementBox` and `overlayKindOf` are per-node predicates on hot
 * walk paths and take no scene index; keying on the spine metadata (which already carries the scene path AND the
 * scene-relative node path) is what lets those three admit a placeholder node without growing a parameter. The
 * index is needed only to resolve the BOX, below — and a node whose box cannot be resolved simply paints nothing.
 */
export function creaturePlaceholderKind(node: MirrorNode): CreaturePlaceholderKind | null {
  const scene = node.spineSceneResPath;
  const path = node.spineNodePath;
  if (scene == null || path == null || !node.spineCurrentAnim) {
    return null;
  }
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  if (scene.startsWith(CREATURE_VISUALS_SCENE_DIR)) {
    return leaf === CREATURE_VISUALS_SPINE_LEAF ? "combat-creature" : null;
  }
  if (leaf === MERCHANT_SPINE_LEAF && MERCHANT_SCENE_FILES.includes(scene.slice(scene.lastIndexOf("/") + 1))) {
    return "shop-merchant";
  }
  return null;
}

/**
 * Should this node exist in the render tree so it can host a stand-in?
 *
 * Read by the three shared paint gates as `isSpineClipNode(node) || isCreaturePlaceholderNode(node)`. On every
 * tier that renders spines the first half is already true, so this clause adds EXACTLY ONE THING: the hard-off
 * tier's creature and merchant nodes, which `isSpineClipNode` refuses (and which therefore had no element, no
 * overlay record and no box at all — "Off leaves no phantom placeholders", which is precisely the behaviour the
 * maintainer asked to change for creatures).
 *
 * `?spineMode=off` is NOT that case and stays fully off: it is a dev-only `?spineMode=` override with no panel
 * control, so someone who typed it asked for no spine role, stand-in included.
 */
export function isCreaturePlaceholderNode(node: MirrorNode): boolean {
  return mirrorSettings.spineMode !== "off" && creaturePlaceholderKind(node) !== null;
}

/**
 * True when this creature will NEVER be sent art, so the stand-in is immediate and permanent rather than a
 * one-second grace. That is the hard-off tier: nothing was requested, so there is nothing to wait for.
 */
export function creatureArtIsUnavailable(node: MirrorNode): boolean {
  return isCreaturePlaceholderNode(node) && !isSpineClipNode(node);
}

/**
 * DOES THIS NODE RENDER A SPINE SURFACE AT ALL — a clip, or the stand-in for one?
 *
 * The single predicate every structural gate in both backends asks, so that "which nodes get a spine surface"
 * cannot be answered differently in five places. A SpineSprite carries no `localRect` and paints no texture, so
 * a `false` here does not merely skip its art: it removes the node's whole reason to exist, and the five gates
 * below each remove a different part of it —
 *
 *   `nodeStyles.nodePaintsContent`   the wide-screen visual-anchor map, and the canvas backend's paint classifier
 *   `nodeStyles.placementBox`        the synthetic zero box that makes the element CARRY the node's transform
 *   `spreadLayout.spreadDrawBox`     the same box on the wide-screen re-layout path (the walk reads THIS one)
 *   `spreadLayout`'s `pointAnchor`   "this node anchors its own visual" rather than being a grouping positioner
 *   `nodeController.needsOwnEl`      whether the DOM builds an element for it in the first place
 *
 * Getting only some of them right is a silent partial render — which is exactly what the first cut of this did:
 * the two box gates passed and `needsOwnEl` did not, so an off-tier creature had a box nobody ever built.
 */
export function isSpineSurfaceNode(node: MirrorNode): boolean {
  return isSpineClipNode(node) || isCreaturePlaceholderNode(node);
}

/** A node's own matrix in its PARENT's space — the wire transform, or identity for a transform-less group. */
function localTransform(node: MirrorNode): Affine {
  return node.transform != null ? (node.transform as Affine) : IDENTITY_AFFINE;
}

/** The ancestor chain `[node, parent, …, root]`. Bounded by tree depth; both call sites walk two or three links. */
function ancestorChain(nodes: NodeMap, node: MirrorNode): MirrorNode[] {
  const chain: MirrorNode[] = [node];
  let cursor = node.parentId != null ? nodes.get(node.parentId) : undefined;
  // A cycle cannot occur in a streamed tree, but a malformed one must not hang the walk.
  while (cursor !== undefined && chain.length < 64) {
    chain.push(cursor);
    cursor = cursor.parentId != null ? nodes.get(cursor.parentId) : undefined;
  }
  return chain;
}

/** The direct child of `parentId` with this name, or undefined. Creatures have a handful of children; bounded. */
function childNamed(
  nodes: NodeMap,
  childrenOf: ChildrenOf,
  parentId: string,
  name: string
): MirrorNode | undefined {
  for (const childId of childrenOf(parentId)) {
    const child = nodes.get(childId);
    if (child?.name === name) {
      return child;
    }
  }
  return undefined;
}

/** A box node is only usable if it actually states an area. */
function hasArea(node: MirrorNode | undefined): node is MirrorNode {
  const rect = node?.localRect;
  return rect != null && rect.width > 0 && rect.height > 0;
}

/**
 * The node whose `localRect` IS the creature's box, or null.
 *
 * Combat: the `Hitbox` under the nearest `combat/creature.tscn` root above the spine node, else the `Bounds`
 * beside the spine node itself. Both carry the same runtime-sized rect, so the order is purely about which one
 * is more reliably present (see the constants above).
 *
 * Shop: the spine node's own parent, the `NMerchantButton`.
 */
function boxOwnerFor(
  nodes: NodeMap,
  childrenOf: ChildrenOf,
  node: MirrorNode,
  kind: CreaturePlaceholderKind
): MirrorNode | null {
  const parent = node.parentId != null ? nodes.get(node.parentId) : undefined;
  if (kind === "shop-merchant") {
    return hasArea(parent) ? parent : null;
  }
  for (const ancestor of ancestorChain(nodes, node)) {
    if (ancestor.sceneFilePath?.endsWith(CREATURE_SCENE_FILE_SUFFIX) !== true) {
      continue;
    }
    const hitbox = childNamed(nodes, childrenOf, ancestor.id, CREATURE_ROOT_BOX_NAME);
    if (hasArea(hitbox)) {
      return hitbox;
    }
    break; // the creature root is here and states no hitbox — the rig's own Bounds is the remaining answer
  }
  const bounds = parent != null ? childNamed(nodes, childrenOf, parent.id, CREATURE_RIG_BOX_NAME) : undefined;
  return hasArea(bounds) ? bounds : null;
}

/**
 * `owner`'s box expressed in `node`'s OWN local space — the space a spine still's `localX/localY` live in, and
 * therefore the space both backends place a sub-layer in.
 *
 * Both nodes hang off one common ancestor, and the wire streams PARENT-RELATIVE transforms, so the two globals'
 * shared prefix cancels and only the relative chains matter:
 *
 *     boxInNodeSpace = inverse(relDown(node)) · relDown(owner) · translate(ownerRect.x, ownerRect.y)
 *
 * where `relDown(x)` is the product of transforms from the common ancestor (exclusive) down to `x` (inclusive).
 * Returns null when the two are unrelated or the node's transform is singular.
 */
function ownerBoxInNodeSpace(nodes: NodeMap, node: MirrorNode, owner: MirrorNode): PlaceholderBox | null {
  const rect = owner.localRect;
  if (rect == null) {
    return null;
  }
  const nodeChain = ancestorChain(nodes, node);
  const ownerChain = ancestorChain(nodes, owner);
  const ownerDepth = new Map<string, number>();
  ownerChain.forEach((n, i) => ownerDepth.set(n.id, i));
  const commonAt = nodeChain.findIndex((n) => ownerDepth.has(n.id));
  if (commonAt < 0) {
    return null;
  }
  const commonId = nodeChain[commonAt].id;

  // `relDown`: the chains are leaf→root, so walking them BACKWARDS from just under the common ancestor composes
  // parent-before-child, which is the order `affineMul(parent, child)` wants.
  const relDown = (chain: readonly MirrorNode[]): Affine => {
    let m: Affine = IDENTITY_AFFINE;
    for (let i = chain.findIndex((n) => n.id === commonId) - 1; i >= 0; i -= 1) {
      m = affineMul(m, localTransform(chain[i]));
    }
    return m;
  };

  const inverseNode = affineInverse(relDown(nodeChain));
  if (inverseNode === null) {
    return null;
  }
  // `nodeMatrix(m, rect)` is `m · translate(rect.x, rect.y)` — the owner's box renders at (0,0,w,h) under it.
  const m = affineMul(inverseNode, nodeMatrix(relDown(ownerChain), rect));

  // The stand-in is an axis-aligned `<img>`, so a rotated box can only be honoured as its bounding box. In
  // practice neither shape rotates; taking the AABB of all four corners is simply what keeps that assumption from
  // silently producing a wrong rect if one ever does.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of [[0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height]]) {
    const x = m[0] * cx + m[2] * cy + m[4];
    const y = m[1] * cx + m[3] * cy + m[5];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The box to stretch the stand-in into, IN THE SPINE NODE'S OWN LOCAL SPACE, or null when this node has no
 * placeholder or the scene has not streamed enough of the creature yet to state one.
 *
 * A null answer is a normal, transient outcome (the creature root arrives before its box children on the first
 * keyframe), not an error: the caller simply paints nothing and asks again on the next reconcile.
 */
export function creaturePlaceholderBox(
  nodes: NodeMap,
  childrenOf: ChildrenOf,
  node: MirrorNode
): PlaceholderBox | null {
  const kind = creaturePlaceholderKind(node);
  if (kind === null || node.transform == null) {
    return null;
  }
  const owner = boxOwnerFor(nodes, childrenOf, node, kind);
  return owner === null ? null : ownerBoxInNodeSpace(nodes, node, owner);
}

/**
 * The placement key both backends compare against to decide whether the `<img>`'s styles need rewriting. Rounded
 * to a tenth of a design pixel: the box is streamed per tick and a creature's idle bob would otherwise rewrite
 * three style properties every frame for a sub-pixel change nobody can see.
 */
export function creaturePlaceholderKey(box: PlaceholderBox): string {
  const r = (v: number): number => Math.round(v * 10) / 10;
  return `${r(box.x)},${r(box.y)},${r(box.width)},${r(box.height)}`;
}
