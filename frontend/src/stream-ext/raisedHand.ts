// stream-ext/raisedHand.ts — the render-stream client's READABLE-HAND module (TAG3).
//
// The same policy as the old mirror's `mirror/raise/handRaisePlan.ts`, applied through godot-scene-web's extension
// API instead of the DOM/canvas walk: holders, the focus ramp, the stand-downs (targeting / hand choice / a dragged
// card) and the creature-HUD shift. Static identity comes from `item_meta` groups the mod tags (RenderStreamItemTagger);
// the parent chain, transforms and visibility come from the applier's `query`; the lift is written as a translate
// override on the holder / HUD subtree.
//
// DIFFERENCES FROM THE OLD MIRROR, by construction of the stream:
//   * No producer tweens: `query.transform` IS the game's current pose, so the "endpoint vs streamed transform" seam
//     (holderLocalY.ts) has no stream twin — the holder's local y is read straight off its draw transform.
//   * No modulate in `ItemQuery` (transforms/visibility/rects only), so the hand-root DIM stand-down (the game greys
//     the hand during a multiplayer end-turn wait) is not detectable here. The three other stand-downs are. Exposing
//     modulate in the query is a GSW change, out of scope for this couch increment.
//   * View-only: there is no held-card input, so "dragging" is only the game's own reparent of a holder onto the hand
//     root (the same signal the old mirror used for a drag it did not originate).
//   * The creature geometry is read as global-rect-minus-root-origin, exact while the creature's ancestors are
//     identity-scale (the common case); a scaled creature reads its geometry scaled by its own factor, which the old
//     mirror avoided by reading parent-relative transforms the stream query does not expose.
//
// DIRTY ONLY. The desired overrides are a pure function of the identity table and the newest applied transaction, so
// the module recomputes and writes only when a new transaction arrived or an item was removed. The ramp itself is
// spatial — a function of the holder's own pose — and the game's own focus tween delivers that pose across
// transactions, so there is no client-side ease to animate. Writing the values an item already has is already a no-op
// in the core; recomputing per frame is the cost the "dirty only" spec forbids.

import type { ItemMeta, ItemMetaBatch, ItemQuery, RenderStreamExtension } from "@godot-scene-web/render-stream-client";

import {
  CREATURE_INTENT_GAP,
  CREATURE_POWER_ROW_H,
  CREATURE_POWER_TOP_FALLBACK,
  CREATURE_RETICLE_TOP_FALLBACK,
  HAND_RAISE_PX
} from "@/mirror/raise/constants";
import { handRaiseDy } from "@/mirror/raise/handRaisePlan";
import {
  RAISE_GROUPS,
  RS_GROUP_CREATURE_HUD,
  RS_GROUP_CREATURE_POWER,
  RS_GROUP_CREATURE_RETICLE,
  RS_GROUP_HAND_CHOICE,
  RS_GROUP_HAND_CONTAINER,
  RS_GROUP_HAND_HOLDER,
  RS_GROUP_HAND_ROOT,
  RS_GROUP_TARGETING_ARROW
} from "@/stream-ext/groups";

/** A holder's pose, read from the frame. */
export interface HolderPose {
  readonly id: number;
  /** The holder's local y in the hand container, or null when it is not a raisable fan card. */
  readonly localY: number | null;
}

/** The creature-HUD measurement the module shifts by (the old creatureHud.ts pair, measured from live geometry). */
export interface CreatureShifts {
  healthBar: number;
  intents: number;
}

export interface CreatureGroupFacts {
  /** The HealthBar / Intents group item id. */
  readonly id: number;
  /** "HealthBar" | "Intents" (the path's last segment). */
  readonly kind: "HealthBar" | "Intents";
  /** The creature root (the group's parent). */
  readonly rootId: number;
  /** The group's top edge in creature-local space. */
  readonly top: number;
  /** The group's own height, presentation px (for the intents bottom edge). */
  readonly height: number;
  /** The creature-local top of the first power row (HealthBar groups only). */
  readonly powerTop: number | null;
  /** The creature-local top of the selection reticle. */
  readonly reticleTop: number | null;
}

export interface RaiseFrameInput {
  readonly holders: readonly HolderPose[];
  readonly targeting: boolean;
  readonly choicePrompt: boolean;
  readonly dragging: boolean;
  readonly creatureGroups: readonly CreatureGroupFacts[];
}

export interface RaiseOffset {
  readonly id: number;
  readonly dy: number;
}

export interface RaisePlan {
  readonly offsets: readonly RaiseOffset[];
  readonly liftPx: number;
  readonly holderCount: number;
  readonly creatureGroupCount: number;
}

/** No holders and no creature HUD — nothing this module owns is on screen. */
export const EMPTY_RAISE_PLAN: RaisePlan = Object.freeze({
  offsets: Object.freeze([]) as readonly RaiseOffset[],
  liftPx: 0,
  holderCount: 0,
  creatureGroupCount: 0
});

/** The three stand-downs the stream can see; a hand choice owns the fan's layout and lifts selected cards itself. */
export function raiseLiftPx(input: RaiseFrameInput): number {
  return input.targeting || input.choicePrompt || input.dragging ? 0 : HAND_RAISE_PX;
}

/** The creature-local reticle and power tops, and the pair of shifts they imply (the old creatureHud.ts measure). */
export function creatureShifts(group: CreatureGroupFacts): CreatureShifts {
  const reticleTop = group.reticleTop ?? CREATURE_RETICLE_TOP_FALLBACK;
  const powerTop = group.powerTop ?? CREATURE_POWER_TOP_FALLBACK;
  const healthBar = reticleTop - (powerTop + CREATURE_POWER_ROW_H);
  const intentsBottom = group.kind === "Intents" ? group.top + group.height : null;
  const intents = intentsBottom == null ? 0 : group.top + healthBar - CREATURE_INTENT_GAP - intentsBottom;
  return { healthBar, intents };
}

/** The shift a HUD group takes: the Intents ride one shift, the state display ("HealthBar") the other. */
export function creatureShiftFor(kind: "HealthBar" | "Intents", shifts: CreatureShifts): number {
  return kind === "Intents" ? shifts.intents : shifts.healthBar;
}

/**
 * One pass's decision, pure of the live frame. Called only while the module is dirty or easing, so the identity is
 * fixed here and the caller's only job is reading `query` into {@link RaiseFrameInput}.
 */
export function computeRaisePlan(input: RaiseFrameInput): RaisePlan {
  const holderCount = input.holders.length;
  const creatureGroupCount = input.creatureGroups.length;
  if (holderCount === 0 && creatureGroupCount === 0) return EMPTY_RAISE_PLAN;

  const lift = raiseLiftPx(input);
  const offsets: RaiseOffset[] = [];

  for (const holder of input.holders) {
    const dy = handRaiseDy(lift, holder.localY);
    if (dy !== 0) offsets.push({ id: holder.id, dy });
  }

  // The two HUD groups of one creature share one measurement (the old code's shiftsByRoot cache).
  const shiftsByRoot = new Map<number, CreatureShifts>();
  for (const group of input.creatureGroups) {
    let shifts = shiftsByRoot.get(group.rootId);
    if (shifts === undefined) {
      shifts = creatureShifts(group);
      shiftsByRoot.set(group.rootId, shifts);
    }
    const dy = Math.round(creatureShiftFor(group.kind, shifts));
    if (dy !== 0) offsets.push({ id: group.id, dy });
  }

  return { offsets, liftPx: lift, holderCount, creatureGroupCount };
}

// -------------------------------------------------------------------------------------------------------------

function pathLeaf(path: string | null | undefined): string {
  if (!path) return "";
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

interface PoseFacts {
  parent: number | null;
  transform: readonly number[] | null;
  rect: { x: number; y: number; w: number; h: number } | null;
  visible: boolean;
  meta: ItemMeta | null;
}

function readFacts(q: ItemQuery, id: number): PoseFacts {
  return {
    parent: q.parent(id),
    transform: q.transform(id),
    rect: q.rect(id),
    visible: q.visible(id),
    meta: q.meta(id)
  };
}

/** The top of `id` in `rootT`'s local space: its global rect top minus the root's global origin. */
function topInLocal(rect: { y: number } | null, rootT: readonly number[]): number {
  return rect === null ? 0 : rect.y - rootT[5];
}

/**
 * The raised-hand extension. Enabled is the viewer's `mirrorSettings.raiseHandCards`; when false the module is not
 * created at all, so a viewer who never turned it on sends an empty extension list and a byte-identical hello.
 */
export function createRaisedHandExtension(): RenderStreamExtension {
  // ids by group, from the last full/delta item_meta table (static identity).
  const holders = new Set<number>();
  const handRoots = new Set<number>();
  const containers = new Set<number>();
  const arrows = new Set<number>();
  const choices = new Set<number>();
  const hud = new Set<number>();
  const reticles = new Set<number>();
  const powers = new Set<number>();

  // The ids this module has an override on right now (so a holder the plan stopped moving is cleared).
  const written = new Set<number>();
  let dirty = true;
  let lastSeq: number | null = null;

  function indexGroup(m: ItemMeta): void {
    for (const g of m.groups) {
      switch (g) {
        case RS_GROUP_HAND_HOLDER: holders.add(m.id); break;
        case RS_GROUP_HAND_ROOT: handRoots.add(m.id); break;
        case RS_GROUP_HAND_CONTAINER: containers.add(m.id); break;
        case RS_GROUP_TARGETING_ARROW: arrows.add(m.id); break;
        case RS_GROUP_HAND_CHOICE: choices.add(m.id); break;
        case RS_GROUP_CREATURE_HUD: hud.add(m.id); break;
        case RS_GROUP_CREATURE_RETICLE: reticles.add(m.id); break;
        case RS_GROUP_CREATURE_POWER: powers.add(m.id); break;
      }
    }
  }

  function clearIds(ids: Iterable<number>): void {
    for (const id of ids) {
      holders.delete(id);
      handRoots.delete(id);
      containers.delete(id);
      arrows.delete(id);
      choices.delete(id);
      hud.delete(id);
      reticles.delete(id);
      powers.delete(id);
    }
  }

  return {
    id: "couchcoop.raisedHand",
    wants: { fields: ["path"], groups: [...RAISE_GROUPS] },
    onItemMeta: (b) => {
      if (b.form === "full") {
        holders.clear();
        handRoots.clear();
        containers.clear();
        arrows.clear();
        choices.clear();
        hud.clear();
        reticles.clear();
        powers.clear();
      }
      for (const m of b.items) indexGroup(m);
      dirty = true;
    },
    onItemsRemoved: (ids) => {
      clearIds(ids);
      dirty = true;
    },
    beforeDraw: (f) => {
      // Recompute only on a new applied transaction or a changed identity table. A redraw (seq null) with neither
      // is a no-op; the ramp itself is spatial (a function of the holder's own pose), and the game's own tween
      // delivers that pose across transactions, so there is nothing to animate client-side.
      const newTx = f.seq !== null && f.seq !== lastSeq;
      if (f.seq !== null) lastSeq = f.seq;
      if (!dirty && !newTx) return;
      dirty = false;
      const q = f.query;

      // The hand container's global origin is the local-y frame every holder is measured in (identity ancestors).
      let containerY: number | null = null;
      for (const id of containers) {
        const t = q.transform(id);
        if (t !== null) {
          containerY = t[5];
          break;
        }
      }

      const handRootId = handRoots.size > 0 ? handRoots.values().next().value as number : undefined;
      const holderPoses: HolderPose[] = [];
      for (const id of holders) {
        const facts = readFacts(q, id);
        if (facts.parent === null || facts.transform === null || containerY === null) continue;
        holderPoses.push({
          id,
          localY: containers.has(facts.parent) ? facts.transform[5] - containerY : null
        });
      }

      let targeting = false;
      for (const id of arrows) {
        if (q.visible(id)) {
          targeting = true;
          break;
        }
      }
      let choicePrompt = false;
      for (const id of choices) {
        if (q.visible(id)) {
          choicePrompt = true;
          break;
        }
      }
      let dragging = false;
      if (handRootId !== undefined) {
        for (const id of holders) {
          if (q.parent(id) === handRootId) {
            dragging = true;
            break;
          }
        }
      }

      const creatureGroups: CreatureGroupFacts[] = [];
      for (const id of hud) {
        const facts = readFacts(q, id);
        const rootId = facts.parent;
        if (rootId === null) continue;
        const rootT = q.transform(rootId);
        if (rootT === null) continue;
        const kind = pathLeaf(facts.meta?.path) === "Intents" ? "Intents" as const : "HealthBar" as const;
        creatureGroups.push({
          id,
          kind,
          rootId,
          top: topInLocal(facts.rect, rootT),
          height: facts.rect?.h ?? 0,
          powerTop: kind === "HealthBar" ? powerTopFor(q, id, rootT, powers) : null,
          reticleTop: reticleTopFor(q, rootId, rootT, reticles)
        });
      }

      const plan = computeRaisePlan({ holders: holderPoses, targeting, choicePrompt, dragging, creatureGroups });
      const desired = new Map<number, number>();
      for (const o of plan.offsets) desired.set(o.id, o.dy);

      for (const [id, target] of desired) {
        f.overrides.translate(id, 0, target);
        written.add(id);
      }
      // A holder / HUD group the plan no longer moves is cleared, so a stale lift never outlives its gate.
      for (const id of written) {
        if (!desired.has(id)) {
          written.delete(id);
          f.overrides.clear(id);
        }
      }
    },
    dispose: () => {
      holders.clear();
      handRoots.clear();
      containers.clear();
      arrows.clear();
      choices.clear();
      hud.clear();
      reticles.clear();
      powers.clear();
      written.clear();
      dirty = false;
    }
  };
}

function reticleTopFor(q: ItemQuery, rootId: number, rootT: readonly number[], reticles: ReadonlySet<number>): number | null {
  for (const childId of q.children(rootId)) {
    if (reticles.has(childId)) return topInLocal(q.rect(childId), rootT);
  }
  return null;
}

function powerTopFor(q: ItemQuery, healthBarId: number, rootT: readonly number[], powers: ReadonlySet<number>): number | null {
  const displayT = q.transform(healthBarId);
  if (displayT === null) return null;
  const displayTop = displayT[5] - rootT[5];
  for (const childId of q.children(healthBarId)) {
    if (powers.has(childId)) {
      const t = q.transform(childId);
      if (t === null) return null;
      return displayTop + (t[5] - displayT[5]);
    }
  }
  return null;
}
