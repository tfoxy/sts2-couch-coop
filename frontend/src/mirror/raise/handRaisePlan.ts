// READABLE-HAND MODE — the whole policy, once, for both stage backends.
//
// WHAT THE MODE DOES. At rest the hand's centre card is drawn with its bottom edge ~119 design px BELOW the 1080
// viewport floor — which is exactly where a card's rules text sits, so on a phone (no hover) a hand can only be
// read one focused card at a time. The mode lifts every holder by that overhang, and moves each creature's health
// bar / powers / nameplate above its target reticle so the raised cards do not cover them. Nothing here reaches
// the game: it is purely what the client DRAWS.
//
// ─── WHAT IS SHARED, AND WHAT IS NOT ────────────────────────────────────────────────────────────────────────────
//
// SHARED (this module): the gates, the focus ramp, the per-holder dy, the creature-HUD loop, and the moved-surface
// map the input inverse is built from. Every number a viewer sees is decided here, so the two stages cannot
// answer the same frame differently — which is the failure mode the DOM/canvas duplication was reported for.
//
// NOT SHARED, by design, and injected through {@link RaiseSceneIndex}:
//
//   * HOW THE SCENE FACTS ARE OBTAINED. The DOM backend maintains its sets incrementally during its element walk;
//     a canvas build has no incremental walk, so it scans (`scanRaiseIndex` below is that scan, and it is the
//     default index for any backend without a walk to hang the sets off).
//   * WHERE A HOLDER IS HEADED (`holderLocalY`). ┌── H10 GUARD ──────────────────────────────────────────────────┐
//     The DOM's version prefers a tween ENDPOINT while a pin or a pending pin-catch-up is in force; the canvas's
//     takes an endpoint only while the tween is genuinely live, and the two stay a port (see that module's own
//     header) rather than being folded together here.
//     The H10 excursion recorded on 2026-09-19 was NOT that difference: the answer was right, and the DOM's eased
//     lift simply LEFT the wrong value, because a producer delta that steps the pose and arms the return tween in
//     one frame moved the pose channel while the lift channel still held the pose before it. That is a channel
//     seam, closed where the channel is written (`handController.noteTransformArmPose` + `holderPaintedLocalY`),
//     and it is why "the ramp said the right thing on the frame it was read" and "the card was drawn past its
//     pose" can both be true. The canvas had the same seam in its own channel — a lift ramped from the retained
//     offset onto a pose that had already stepped — and it is closed the same way, at its own arm
//     (`interactionRuntime.noteTransformArmPose`), NOT by changing what this ramp answers. Both arms are measured
//     across a focus change in `handLiftPhase.spec.ts`. └──────────────────────────────────────────────────────┘
//   * HOW THE ANSWER IS APPLIED. The DOM writes the individual CSS `translate` property, which composes with the
//     baked matrix and moves the element's subtree for free; the canvas writes a COSMETIC OFFSET inherited by the
//     subtree in its draw list. THE LAW BOTH IMPLEMENT: **a raise dy is expressed in the OWNER'S PARENT SPACE** —
//     that is what a CSS `translate` on an element does, so an offset that is added in raw global space is only
//     the same answer while the owner's ancestor chain is the identity.
//
// THE TWO HALVES LAND TOGETHER, ALWAYS. A raise without its INPUT INVERSE is worse than no raise: the mirror's Y
// is a strict 1:1 fraction of the stage (the whole spread machinery is horizontal), so a pointer that lands on a
// card where it is DRAWN would resolve to a game point a full lift above the thing it looks like. So `plan()`
// returns the offsets and the moved-surface map in ONE value, and each backend publishes its input stamps from
// the same map it drew with. `raiseInverse.ts` is the consumer.

import {
  HAND_CHOICE_NAMES,
  HAND_CHOICE_TYPES,
  HAND_CONTAINER_NAME,
  HAND_HOLDER_TYPE,
  HAND_RAISE_PX,
  HAND_RAISE_RAMP_END_Y,
  HAND_RAISE_RAMP_START_Y,
  HAND_ROOT_TYPE,
  TARGETING_TYPES
} from "@/mirror/raise/constants";
import {
  creatureHudMeasure,
  creatureShiftFor,
  isCreatureHudGroup,
  type ChildrenOf,
  type CreatureShifts,
  type NodeMap
} from "@/mirror/raise/creatureHud";
import { nodeTypeLeaf, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

export type { ChildrenOf, NodeMap };

/** A design-space translate applied to a node AND EVERYTHING UNDER IT. */
export interface RaiseOffset {
  dx: number;
  dy: number;
}

/** What the caller has to tell the pass that is not in the scene state: the setting, and this client's own drag. */
export interface HandRaiseInput {
  /** `mirrorSettings.raiseHandCards`. Off ⇒ an empty plan, which is provably the identity on both halves. */
  enabled: boolean;
  /**
   * The card this client's finger is holding and how — known a frame EARLIER than the wire can say so. A drag
   * lowers the hand immediately; a long-press "peek" does not (the hand stays up behind the peeked card).
   */
  heldCardId: string | null;
  heldMode: "drag" | "peek";
}

/**
 * Everything a pass needs to know about the scene, however its backend came by it.
 *
 * The five membership facts are what each backend maintains its own way (see the header). Everything derived from
 * them — the gates, the shifts, the dy — is this module's.
 */
export interface RaiseSceneIndex {
  /** The live scene map, by node id. */
  nodes: NodeMap;
  /** A node's children, in wire order. */
  childrenOf: ChildrenOf;
  /** Every hand-card holder currently on screen. */
  holders: Iterable<string>;
  /** The hand ROOT (`NPlayerHand`), whose dim the mode stands aside for and whose children are dragged cards. */
  handRootId: string | null;
  /** hitbox id → holder id: the real 300x422 footprints a pointer can land on. */
  handHitboxes: ReadonlyMap<string, string>;
  /** creature HUD group id → creature root id. */
  creatureGroups: ReadonlyMap<string, string>;
  /** Is a targeting arrow visible right now — the game's own "something is being aimed" signal? */
  targeting: boolean;
  /** Is a from-hand card-choice prompt (sustain / discard / exhaust / enchant) up? */
  choicePrompt: boolean;
  /**
   * The y this holder is currently HEADED FOR IN ITS CONTAINER, or null when it is not a raisable fan card at all.
   * The ONE number the focus ramp is a function of — and a backend port, see the H10 guard in the header.
   */
  holderLocalY(id: string): number | null;
}

/** Everything one pass decided — the DRAWN half and the INPUT half, produced together. See the header. */
export interface HandRaisePlan {
  /** Offsets to apply: hand holders and creature HUD groups, each moving its own subtree. */
  offsets: Map<string, RaiseOffset>;
  /**
   * Every MOVED hit surface, by node id, with the dy it was DRAWN at (the rounded value — a pointer is inverted
   * through the pose it can see, not through the fractional one the ramp computed).
   */
  movedRectDy: Map<string, number>;
  /** The hand HITBOX ids, valued by their holder — the surfaces the mode governs wholesale, offset or not. */
  handHitboxes: ReadonlyMap<string, string>;
  /**
   * Creature HUD group id → creature root id, straight off the index.
   *
   * `gates.creatureGroups` already reports how MANY there are; this is the same index by identity, so the
   * diagnostic seam can re-measure the exact creatures this pass shifted instead of scanning for them again and
   * risking a different answer.
   */
  creatureGroups: ReadonlyMap<string, string>;
  /** The lift currently in force (0 whenever a gate is holding it down), for the debug seam. */
  liftPx: number;
  /** Why the lift is 0, for the debug seam. */
  gates: {
    targeting: boolean;
    choicePrompt: boolean;
    dragging: boolean;
    dimmed: boolean;
    handRootId: string | null;
    holders: number;
    creatureGroups: number;
  };
}

/** No children — one frozen array, so a creature-less scene allocates nothing for the index it never uses. */
export const EMPTY_CHILDREN: readonly string[] = Object.freeze([]);

/**
 * The empty plan — the mode off, no combat, or the hand lowered. Shared, so an off viewer allocates nothing, and
 * exported so a backend's "no pass has run yet" state IS this value rather than a second spelling of it.
 */
export const EMPTY_HAND_RAISE_PLAN: HandRaisePlan = {
  offsets: new Map(),
  movedRectDy: new Map(),
  handHitboxes: new Map(),
  creatureGroups: new Map(),
  liftPx: 0,
  gates: {
    targeting: false,
    choicePrompt: false,
    dragging: false,
    dimmed: false,
    handRootId: null,
    holders: 0,
    creatureGroups: 0
  }
};

/**
 * Is the mode capable of moving anything at all? The cheap gate — asked BEFORE an index is built, so a backend
 * that has to SCAN for its membership facts (the canvas) does not scan for a mode nobody turned on.
 */
export function raiseModeOn(enabled: boolean): boolean {
  return enabled && HAND_RAISE_PX > 0;
}

/**
 * The focus ramp: 0 across the resting fan, 1 at the game's focused-holder pose, linear between.
 *
 * ONE continuous function covers focus, un-focus and a cursor-dragged holder, and the applied lift is
 * `HAND_RAISE_PX·(1−t)` — so a focused holder lifts by 0 (the game's own pose, untouched) and while the game
 * tweens it back down `t` runs 1→0 and the card rises into the raised rest pose on the same curve. No threshold,
 * no latch, no focus signal on the wire.
 */
export function handRaiseRamp(localY: number): number {
  const span = HAND_RAISE_RAMP_START_Y - HAND_RAISE_RAMP_END_Y;
  const t = (HAND_RAISE_RAMP_START_Y - localY) / span;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/**
 * The lift a holder at `localY` is drawn with, in design px (negative = raised), for a mode running at `liftPx`.
 *
 * ONE SPELLING of the ramp arithmetic, because it is asked in two places for the same frame: the plan below asks
 * it of the pose a holder is HEADED for, and the DOM asks it of the pose a holder is drawn at as it puts its lift
 * channel in phase with a transform ease (see `holderPaintedLocalY`). Two spellings would let the value a card
 * eases FROM and the value it eases TO come off different arithmetic.
 *
 * Rounded, because a sub-pixel ramp step must not churn a rebuild (canvas) or rewrite a style attribute (DOM)
 * every frame of a tween — and the ROUNDED value is what the input inverse gets, because it is what was drawn.
 */
export function handRaiseDy(liftPx: number, localY: number | null): number {
  return localY == null ? 0 : Math.round(-liftPx * (1 - handRaiseRamp(localY)));
}

/**
 * Is this holder still one of the FAN's cards — i.e. a child of the hand CONTAINER?
 *
 * The game reparents a holder onto the hand ROOT for as long as the card is out of the hand: while it is being
 * dragged, and while it sits in the play position after a click selected it. Such a holder keeps the game's own
 * pose (that is the point of the reparent), so it is neither raisable nor ANCHOR-TARGETABLE. Exported because both
 * backends' `holderLocalY` and the DOM's anchor pass ask it, and a predicate restated is a predicate that will
 * disagree with itself.
 */
export function holderInFan(nodes: NodeMap, id: string): boolean {
  const node = nodes.get(id);
  const parent = node?.parentId != null ? nodes.get(node.parentId) : undefined;
  return parent !== undefined && parent.name === HAND_CONTAINER_NAME;
}

/**
 * A VISIBLE targeting arrow — the game's own "a card or potion is being aimed" signal.
 *
 * Deliberately not gated on THIS client holding anything: the arrow appears for a mouse drag and for a potion too,
 * neither of which goes through `setHeldCard`.
 */
export function isVisibleTargetingArrow(node: MirrorNode, leaf: string): boolean {
  return node.visible && TARGETING_TYPES.has(leaf);
}

/**
 * A visible from-hand card-choice prompt (sustain / discard / exhaust / enchant).
 *
 * It OWNS the hand's layout: it lifts SELECTED cards out of the fan itself, so the raise would fight it (and the
 * focus ramp would read those lifted cards as "focused" and sink them below their unselected neighbours). Stand
 * aside exactly like a drag.
 */
export function isVisibleHandChoice(node: MirrorNode, leaf: string): boolean {
  return node.visible && isHandChoiceNode(node, leaf);
}

/**
 * The IDENTITY half of the predicate above, without the visibility test — for a backend that tracks membership on
 * visibility FLIPS (the DOM walk) rather than asking per frame.
 */
export function isHandChoiceNode(node: MirrorNode, leaf: string): boolean {
  return HAND_CHOICE_TYPES.has(leaf) || HAND_CHOICE_NAMES.has(node.name);
}

/** The game has deliberately dimmed the hand (multiplayer end-turn wait): it also lowers it, and we must not fight that. */
export function handRootDimmed(nodes: NodeMap, handRootId: string | null): boolean {
  const mod = handRootId != null ? nodes.get(handRootId)?.modulate : null;
  // The game greys the hand root to 0.5; anything short of white means "the game is hiding this on purpose".
  return mod != null && (mod.r < 0.9 || mod.g < 0.9 || mod.b < 0.9);
}

/**
 * Is a hand card being DRAGGED right now? Two independent answers, either of which lowers the hand:
 *   - the game reparents the dragged holder off the hand CONTAINER onto the hand ROOT for the drag's duration, so
 *     a holder whose parent IS the root is a card in flight (covers mouse and touch, targeted or not);
 *   - this client's own touch drag, known a frame earlier than the wire can say so.
 * A visible targeting arrow is a gate of its own, not this one.
 */
export function isHandDragActive(index: RaiseSceneIndex, input: HandRaiseInput): boolean {
  if (input.heldCardId != null && input.heldMode === "drag") {
    return true;
  }
  if (index.handRootId == null) {
    return false;
  }
  for (const holderId of index.holders) {
    if (index.nodes.get(holderId)?.parentId === index.handRootId) {
      return true;
    }
  }
  return false;
}

/**
 * Plan one frame's raise: which nodes move, by how much, and which hit surfaces went with them.
 *
 * A pure function of the index plus the two live facts in {@link HandRaiseInput} — so a caller can run it, diff it
 * against the last one, and repaint only when it changed.
 */
export function planHandRaise(index: RaiseSceneIndex, input: HandRaiseInput): HandRaisePlan {
  // The mode off is the identity on BOTH halves — no offset written, no stamp published — so it costs one branch
  // and not a walk. (`raiseGoverned` keys on the moved-surface map being non-empty, so an empty plan also leaves
  // the input side byte-identical to not having the feature.)
  if (!raiseModeOn(input.enabled)) {
    return EMPTY_HAND_RAISE_PLAN;
  }
  const { nodes, childrenOf } = index;
  let holderCount = 0;
  for (const _ of index.holders) {
    holderCount++;
  }
  if (holderCount === 0 && index.creatureGroups.size === 0) {
    return EMPTY_HAND_RAISE_PLAN; // not in combat — nothing this mode owns is on screen
  }

  const dragging = isHandDragActive(index, input);
  const dimmed = handRootDimmed(nodes, index.handRootId);
  const lift = index.targeting || index.choicePrompt || dragging || dimmed ? 0 : HAND_RAISE_PX;

  const offsets = new Map<string, RaiseOffset>();
  const movedRectDy = new Map<string, number>();

  // --- the hand -----------------------------------------------------------------------------------------------
  for (const holderId of index.holders) {
    const localY = lift > 0 ? index.holderLocalY(holderId) : null;
    const rounded = handRaiseDy(lift, localY);
    if (rounded !== 0) {
      offsets.set(holderId, { dx: 0, dy: rounded });
      // The holder itself is a zero-size anchor; its `Hitbox` child is the box a pointer can land on.
      for (const [hitboxId, ownerId] of index.handHitboxes) {
        if (ownerId === holderId) {
          movedRectDy.set(hitboxId, rounded);
        }
      }
    }
  }

  // --- the creature HUD ---------------------------------------------------------------------------------------
  //
  // Moves for the whole MODE, never for a drag: the point of moving it is that the health bars and powers stay
  // readable while a card is in the air.
  const shiftsByRoot = new Map<string, CreatureShifts>();
  for (const [groupId, rootId] of index.creatureGroups) {
    let shifts = shiftsByRoot.get(rootId);
    if (!shifts) {
      shifts = creatureHudMeasure(nodes, childrenOf, rootId);
      shiftsByRoot.set(rootId, shifts);
    }
    const dy = Math.round(creatureShiftFor(nodes.get(groupId)?.name, shifts));
    if (dy !== 0) {
      offsets.set(groupId, { dx: 0, dy });
      // The group's own hit surfaces (the hp-bar tooltip box, the co-op ally intent) are its DESCENDANTS, so the
      // shift is resolved through the moved ancestor rather than per node.
      collectMovedRects(nodes, childrenOf, groupId, dy, movedRectDy);
    }
  }

  return {
    offsets,
    movedRectDy,
    handHitboxes: index.handHitboxes,
    creatureGroups: index.creatureGroups,
    liftPx: lift,
    gates: {
      targeting: index.targeting,
      choicePrompt: index.choicePrompt,
      dragging,
      dimmed,
      handRootId: index.handRootId,
      holders: holderCount,
      creatureGroups: index.creatureGroups.size
    }
  };
}

/**
 * Every mouse-visible (Stop/Pass) node at or under `rootId`, recorded with the root's shift. Bounded by the
 * creature HUD subtree (a health bar + a handful of powers + at most one ally intent), and only walked while the
 * mode is on.
 */
function collectMovedRects(
  nodes: NodeMap,
  childrenOf: ChildrenOf,
  rootId: string,
  dy: number,
  out: Map<string, number>
): void {
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = nodes.get(id);
    if (!node) {
      continue;
    }
    if (node.mouseFilter === 0 || node.mouseFilter === 1) {
      out.set(id, dy);
    }
    for (const childId of childrenOf(id)) {
      stack.push(childId);
    }
  }
}

// --- the default index: one scan, for a backend with no incremental walk -----------------------------------------

/** The membership half of {@link RaiseSceneIndex} — everything a scan can answer without a pose source. */
export interface RaiseSceneScan {
  handRootId: string | null;
  holders: Set<string>;
  handHitboxes: Map<string, string>;
  creatureGroups: Map<string, string>;
  targeting: boolean;
  choicePrompt: boolean;
}

/**
 * One pass over the state for everything the mode keys on.
 *
 * The DOM backend maintains these five as SETS edited during its element walk; a canvas build has no incremental
 * walk to hang them off, and a single scan over a combat scene's ~3,000 nodes is a few microseconds against a
 * build that already touches every one of them.
 */
export function scanRaiseIndex(nodes: NodeMap): RaiseSceneScan {
  const scan: RaiseSceneScan = {
    handRootId: null,
    holders: new Set<string>(),
    handHitboxes: new Map<string, string>(),
    creatureGroups: new Map<string, string>(),
    targeting: false,
    choicePrompt: false
  };
  for (const node of nodes.values()) {
    const leaf = nodeTypeLeaf(node.nodeType);
    if (leaf === HAND_HOLDER_TYPE) {
      scan.holders.add(node.id);
    } else if (leaf === HAND_ROOT_TYPE) {
      scan.handRootId = node.id;
    } else if (node.name === "Hitbox" && node.parentId != null) {
      // Creatures have a `Hitbox` too, hence the parent-TYPE check.
      const holder = nodes.get(node.parentId);
      if (holder && nodeTypeLeaf(holder.nodeType) === HAND_HOLDER_TYPE) {
        scan.handHitboxes.set(node.id, node.parentId);
      }
    }
    if (isVisibleTargetingArrow(node, leaf)) {
      scan.targeting = true;
    }
    if (isVisibleHandChoice(node, leaf)) {
      scan.choicePrompt = true;
    }
    if (isCreatureHudGroup(nodes, node) && node.parentId != null) {
      scan.creatureGroups.set(node.id, node.parentId);
    }
  }
  return scan;
}

/**
 * Is the game aiming something right now? The scan's targeting answer, on its own.
 *
 * A caller that only needs this one bit (the held-card lift) must not pay for the whole scan; with an early return
 * it stops at the first arrow it finds.
 */
export function anyTargetingArrowVisible(nodes: NodeMap): boolean {
  for (const node of nodes.values()) {
    if (isVisibleTargetingArrow(node, nodeTypeLeaf(node.nodeType))) {
      return true;
    }
  }
  return false;
}

/** One pass over `orderedIds` for a parent → children index — the canvas's `childrenOf`. */
export function createChildIndex(state: MirrorState): ChildrenOf {
  const byParent = new Map<string, string[]>();
  for (const id of state.orderedIds) {
    const parentId = state.nodes.get(id)?.parentId;
    if (parentId == null) {
      continue;
    }
    const kids = byParent.get(parentId);
    if (kids) {
      kids.push(id);
    } else {
      byParent.set(parentId, [id]);
    }
  }
  return (id) => byParent.get(id) ?? EMPTY_CHILDREN;
}
