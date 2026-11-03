// stream-ext/heldCard.ts — the render-stream client's HELD-CARD LIFT module (the stream's `raiseHeldCard` and
// `unfocusOnRelease` pair).
//
// The old mirror's cosmetic touch lift (`mirrorRenderer.setHeldCard` → `raise/heldLift.ts`): while a finger holds a
// HAND card — dragging it, or long-pressing to peek — the card is drawn lifted above the fingertip so the hand does
// not cover it. The lift is a client-side `translate` override composed with the card's own pose; the game is never
// told, and INP1's `toGame` inverse already un-maps a pointer that lands on the lifted card back to the game's
// coordinate. Identity is the `couchcoop_rs_hand_holder` group: the hit item under the finger is a card's CHILD, so
// the module climbs `query.parent` to the hand holder (the card's direct parent) and lifts THAT card, on a different
// item id than the raised-hand module's holder lift — so the two lifts compose instead of fighting over one override.
//
// The GESTURE (when to lift) belongs to the input channel (`streamInput.ts`); this module owns the identity climb
// and the override. `unfocusOnRelease` is also the input channel's: on a peek release it re-hovers the seat to clear
// the focus, so the peeked card returns to the hand. It lands here as the pair's other half because the peek is the
// long-press hand-card gesture the lift enables.
//
// DIRTY ONLY. The desired override is a function of the held card, the finger's game y, the gesture mode and the
// targeting arrow's visibility (the game aiming drops a drag's lift), so it recomputes on a new transaction or a
// controller call — never per frame otherwise. A controller call asks the session for a redraw, so the lift shows
// on the next frame callback rather than waiting for the seat's next transaction.

import type {
  ExtensionSession,
  ItemMeta,
  ItemMetaBatch,
  ItemQuery,
  RenderStreamExtension
} from "@godot-scene-web/render-stream-client";

import { decideHeldLift, heldLiftPx, type HeldMode } from "@/mirror/raise/heldLift";
import { HELD_CARD_GROUPS, RS_GROUP_HAND_HOLDER, RS_GROUP_TARGETING_ARROW } from "@/stream-ext/groups";

/** The hand holder (and its card child) that owns a drawn item, or null when it is not under a hand card. */
export interface HeldCardResolve {
  /** The card to lift — the hand holder's direct child that contains the hit item. */
  readonly card: number;
  /** The hand holder (group `couchcoop_rs_hand_holder`). */
  readonly holder: number;
}

/** The surface the input channel drives. */
export interface HeldCardController {
  /** The hand card under this drawn item (a card's child), or null when it is not a hand card. */
  handCardFor(hitItem: number): number | null;
  /** Set or clear the finger-held card. `hitItem` is the topmost drawn item at the finger. */
  setHeld(hitItem: number | null, gameY: number, mode: HeldMode): void;
  dispose(): void;
}

/** How deep the identity climb reads (a card's child → card → holder is three steps). */
const MAX_CLIMB = 16;

export function createHeldCardExtension(): { extension: RenderStreamExtension; controller: HeldCardController } {
  const holders = new Set<number>();
  const arrows = new Set<number>();
  const written = new Set<number>();

  let query: ItemQuery | null = null;
  let session: ExtensionSession | null = null;
  let heldCard: number | null = null;
  let heldMode: HeldMode = "drag";
  let heldFingerY = 0;
  let dragStartY: number | null = null;
  let heldLifted = false;
  let heldEnteredPlayZone = false;
  let dirty = true;
  let lastSeq: number | null = null;

  function indexMeta(m: ItemMeta): void {
    for (const g of m.groups) {
      if (g === RS_GROUP_HAND_HOLDER) holders.add(m.id);
      else if (g === RS_GROUP_TARGETING_ARROW) arrows.add(m.id);
    }
  }

  function clearIds(ids: Iterable<number>): void {
    for (const id of ids) {
      holders.delete(id);
      arrows.delete(id);
    }
  }

  /** The hand holder + its card child that contains `hitItem`, or null. */
  function resolveHeld(hitItem: number): HeldCardResolve | null {
    if (query === null) return null;
    let cur: number | null = hitItem;
    for (let depth = 0; cur !== null && depth < MAX_CLIMB; depth++) {
      const parent = query.parent(cur);
      if (parent !== null && holders.has(parent)) {
        return { card: cur, holder: parent };
      }
      cur = parent;
    }
    return null;
  }

  const controller: HeldCardController = {
    handCardFor(hitItem) {
      return resolveHeld(hitItem)?.card ?? null;
    },
    setHeld(hitItem, gameY, mode) {
      const resolved = hitItem === null ? null : resolveHeld(hitItem);
      if (resolved === null) {
        if (heldCard !== null) {
          heldCard = null;
          heldLifted = false;
          heldEnteredPlayZone = false;
          dragStartY = null;
          dirty = true;
          session?.requestRedraw();
        }
        return;
      }
      if (resolved.card !== heldCard) {
        heldCard = resolved.card;
        heldMode = mode;
        heldFingerY = gameY;
        dragStartY = gameY;
        heldLifted = false;
        heldEnteredPlayZone = false;
      } else {
        heldMode = mode;
        heldFingerY = gameY;
      }
      dirty = true;
      session?.requestRedraw();
    },
    dispose() {
      holders.clear();
      arrows.clear();
      written.clear();
      query = null;
      session = null;
      heldCard = null;
      heldLifted = false;
      heldEnteredPlayZone = false;
      dragStartY = null;
      dirty = false;
    }
  };

  const extension: RenderStreamExtension = {
    id: "couchcoop.heldCard",
    wants: { groups: [...HELD_CARD_GROUPS] },
    onSession: (s) => {
      session = s;
    },
    onItemMeta: (b) => {
      if (b.form === "full") {
        holders.clear();
        arrows.clear();
      }
      for (const m of b.items) indexMeta(m);
      dirty = true;
    },
    onItemsRemoved: (ids) => {
      clearIds(ids);
      for (const id of ids) {
        if (id === heldCard) {
          heldCard = null;
          heldLifted = false;
          heldEnteredPlayZone = false;
          dragStartY = null;
          break;
        }
      }
      dirty = true;
    },
    beforeDraw: (f) => {
      query = f.query;
      const newTx = f.seq !== null && f.seq !== lastSeq;
      if (f.seq !== null) lastSeq = f.seq;
      if (!dirty && !newTx) return;
      dirty = false;

      if (heldCard === null) {
        for (const id of written) f.overrides.clear(id);
        written.clear();
        return;
      }

      let targeting = false;
      for (const id of arrows) {
        if (f.query.visible(id)) {
          targeting = true;
          break;
        }
      }

      const decided = decideHeldLift({
        mode: heldMode,
        targeting,
        fingerY: heldFingerY,
        dragStartY,
        lifted: heldLifted,
        enteredPlayZone: heldEnteredPlayZone
      });
      heldLifted = decided.lifted;
      heldEnteredPlayZone = decided.enteredPlayZone;
      const dy = -heldLiftPx(heldCard !== null, heldMode, heldLifted);

      if (dy !== 0) {
        f.overrides.translate(heldCard, 0, dy);
        written.add(heldCard);
      } else {
        f.overrides.clear(heldCard);
        written.delete(heldCard);
      }
      // A card the plan no longer holds is cleared, so a stale lift never outlives the hold.
      for (const id of written) {
        if (id !== heldCard) {
          written.delete(id);
          f.overrides.clear(id);
        }
      }
    },
    dispose: () => controller.dispose()
  };

  return { extension, controller };
}
