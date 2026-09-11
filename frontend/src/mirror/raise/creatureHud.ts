// THE CREATURE-HUD SHIFT — the half of readable-hand mode that is not the hand.
//
// With the hand raised, a creature's health bar, powers and nameplate (the one `creature_state_display` group,
// drawn BELOW the creature) would sit behind the cards, so the whole group moves ABOVE the creature's target
// reticle, and the intents move up to clear it in turn.
//
// ONE COPY, TWO BACKENDS. This measurement used to exist twice — `mirrorRenderer.creatureHudShifts` and
// `canvas/handRaise.creatureHudMeasure` — with the same formula written out in both, which is exactly the shape a
// "the canvas puts the HP bar higher than the DOM does" report cannot be reasoned about in. Both backends now
// measure HERE, so any remaining divergence is in how the answer is APPLIED and nowhere else.
//
// The two rules, in creature-local px:
//   health bar — the FIRST POWER ROW's bottom edge lands on the reticle's top edge ("first power bar directly
//                above the reticle"), carrying the hp bar and the nameplate with it;
//   intents    — the same gap they keep above the creature today, now measured above the SHIFTED hp bar.

import {
  CREATURE_HUD_NAMES,
  CREATURE_INTENT_GAP,
  CREATURE_POWER_ROW_H,
  CREATURE_POWER_TOP_FALLBACK,
  CREATURE_RETICLE_TOP_FALLBACK,
  CREATURE_SCENE_FILE_SUFFIX
} from "@/mirror/raise/constants";
import type { MirrorNode } from "@/mirror/sceneTree";

/** The live scene map, by node id — the retained one in both backends. */
export type NodeMap = ReadonlyMap<string, MirrorNode>;

/** A node's children, in wire order. The DOM hands its walk-maintained index; the canvas builds one per pass. */
export type ChildrenOf = (id: string) => readonly string[];

/** One creature-local pair of shifts, measured from that creature's LIVE geometry. */
export interface CreatureShifts {
  healthBar: number;
  intents: number;
}

/**
 * …and every TERM the pair was built out of, for the diagnostic seam (`__mirrorRaiseProbe`).
 *
 * U3b is a report that the raised HP bar and powers sit "a little higher than they should", and the ranked
 * explanations are told apart by exactly these numbers: with ONE measurement shared by both backends they can no
 * longer differ in what they MEASURE, so a probe that still shows a difference has named the APPLICATION. A probe
 * that published only the answer could not say that, so it publishes the working.
 */
export interface CreatureHudMeasure extends CreatureShifts {
  /** Creature-local top of the selection reticle, and whether it came from the fallback constant. */
  reticleTop: number;
  reticleFallback: boolean;
  /** …the state display's own top (0 when the creature has no HealthBar child at all). */
  displayTop: number;
  displayMissing: boolean;
  /** …the first power row's top, and whether IT fell back. */
  powerTop: number;
  powerFallback: boolean;
  /** …the intent row's bottom edge, or null when there is no intent row (which zeroes the intents shift). */
  intentsBottom: number | null;
}

/**
 * Is this one of the two creature HUD groups the mode moves?
 *
 * SCENE IDENTITY, not just a name: both groups are direct children of an instanced creature root, and the same two
 * names occur elsewhere — a creature's own state display re-uses "HealthBar" for the bar inside it, which must NOT
 * move independently of the group it is part of.
 */
export function isCreatureHudGroup(nodes: NodeMap, node: MirrorNode): boolean {
  if (!CREATURE_HUD_NAMES.has(node.name) || node.parentId == null) {
    return false;
  }
  return nodes.get(node.parentId)?.sceneFilePath?.endsWith(CREATURE_SCENE_FILE_SUFFIX) === true;
}

/** A creature child's own y in creature-local space (its streamed placement is parent-relative). */
function creatureChildY(node: MirrorNode | undefined): number | null {
  if (!node?.transform) {
    return null;
  }
  return node.transform[5] + (node.localRect?.y ?? 0);
}

/** The direct child of `rootId` with this name, or undefined. Creatures have a handful of children; bounded. */
function creatureChild(
  nodes: NodeMap,
  childrenOf: ChildrenOf,
  rootId: string,
  name: string
): MirrorNode | undefined {
  for (const childId of childrenOf(rootId)) {
    const child = nodes.get(childId);
    if (child?.name === name) {
      return child;
    }
  }
  return undefined;
}

/**
 * The two creature-local shifts for one creature, MEASURED from its live geometry rather than assumed, WITH THE
 * WORKING the diagnostic seam prints.
 *
 * The obvious constant is only right for a creature the authored default size: the game RE-PLACES both the
 * selection reticle and the intent row at runtime to wrap each creature's ACTUAL drawn height, so a big enemy's
 * reticle sits far higher. Both are streamed, so both are read.
 */
export function creatureHudMeasure(
  nodes: NodeMap,
  childrenOf: ChildrenOf,
  rootId: string
): CreatureHudMeasure {
  const reticle = creatureChild(nodes, childrenOf, rootId, "SelectionReticle");
  const healthBar = creatureChild(nodes, childrenOf, rootId, "HealthBar");
  const intents = creatureChild(nodes, childrenOf, rootId, "Intents");
  const reticleY = creatureChildY(reticle);
  const reticleTop = reticleY ?? CREATURE_RETICLE_TOP_FALLBACK;
  const displayY = creatureChildY(healthBar);
  const displayTop = displayY ?? 0;
  // The power container is a child of the state display, so its creature-local origin is the sum.
  const powerNode = healthBar != null ? creatureChild(nodes, childrenOf, healthBar.id, "PowerContainer") : undefined;
  const powerTop = powerNode?.transform != null ? displayTop + powerNode.transform[5] : CREATURE_POWER_TOP_FALLBACK;
  const healthBarDy = reticleTop - (powerTop + CREATURE_POWER_ROW_H);
  const intentsTop = creatureChildY(intents);
  const intentsBottom = intentsTop == null ? null : intentsTop + (intents?.localRect?.height ?? 0);
  const intentsDy = intentsBottom == null ? 0 : displayTop + healthBarDy - CREATURE_INTENT_GAP - intentsBottom;
  return {
    healthBar: healthBarDy,
    intents: intentsDy,
    reticleTop,
    reticleFallback: reticleY == null,
    displayTop,
    displayMissing: displayY == null,
    powerTop,
    powerFallback: powerNode?.transform == null,
    intentsBottom
  };
}

/**
 * Which of the pair a given HUD group takes. The group's NAME is the whole rule — "Intents" rides the intent
 * shift, the state display ("HealthBar") rides the other — and it is written once so the two backends cannot
 * disagree about which group is which.
 */
export function creatureShiftFor(groupName: string | undefined, shifts: CreatureShifts): number {
  return groupName === "Intents" ? shifts.intents : shifts.healthBar;
}
