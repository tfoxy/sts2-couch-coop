// stream-ext/confirmTap.ts — the render-stream client's CONFIRM-TAP module (the stream's `confirmTap` setting).
//
// The old mirror's client confirm button (mirror/confirmTap.ts + MirrorConfirmButton.vue), re-anchored to the
// streaming seat: on the screens where a tap CONSUMES a run reward — card rewards, event options, shop purchases,
// multiplayer treasure relics, rest-site choices — a tap only ever FOCUSES, and a DOM confirm button commits it.
// The classification is group-based here instead of node-type-based: the mod tags each confirm-eligible widget with
// its own `item_meta` group, and this module climbs from the hit item (a widget's CHILD) to that widget. The hit is the
// Control Godot's GUI would pick (host filters select tree order), and on a card reward that is the card
// holder's undrawn `Hitbox`, which sits BESIDE the card it stands for, not inside it: a hit that climbs to no widget
// takes the one reward card among its siblings.
//
// The button is couch product UI (RenderStreamStage mounts MirrorConfirmButton); this module classifies choices
// and holds their live state. The target rect supplies the overlay coverage check, while the button keeps its
// authored bottom-right presentation slot. Nothing here reaches the game: the commit is a plain left
// click re-sent at the coordinate the focus hover already went to, owned by the input channel.

import type { ItemMeta, ItemQuery, Rect, RenderStreamExtension } from "@godot-scene-web/render-stream-client";
import { reactive } from "vue";

import type { ConfirmTapKind } from "@/mirror/confirmTap";
import { PROCEED_BUTTON_SCENE_FILE_SUFFIX } from "@/mirror/renderer/interactionPolicy";
import { isCardSelection, isCopiedItem, itemTypes } from "@/stream-ext/pointerTargets";
import {
  CONFIRM_TAP_GROUPS,
  RS_GROUP_CARD_REWARD_CARD,
  RS_GROUP_EVENT_OPTION,
  RS_GROUP_REST_SITE,
  RS_GROUP_SHOP_ITEM,
  RS_GROUP_TREASURE_RELIC
} from "@/stream-ext/groups";

/** The singleplayer treasure chest is not a confirm target (its Skip button sits where the confirm button would). */
const SINGLEPLAYER_RELIC_HOLDER_NAME = "SingleplayerRelicHolder";

/** The live confirm-button state (read by RenderStreamStage's button). */
export interface StreamConfirmState {
  /** The confirm-eligible widget the button will commit, or null for no button. */
  targetId: number | null;
  kind: ConfirmTapKind | null;
  belowOverlay: boolean;
  /** The widget's presentation-space rect, for coverage checks. */
  rect: Rect | null;
}

export interface ConfirmTapHit {
  readonly id: number;
  readonly kind: ConfirmTapKind;
  readonly retapActivates?: boolean;
}

export interface ConfirmTapController {
  /** The confirm-eligible widget this hit item belongs to (a widget's child, or a reward card's Hitbox), or null. */
  classify(hitItem: number): ConfirmTapHit | null;
  /** Raise the button for a classified widget (a refused show is a hide). */
  show(id: number, kind: ConfirmTapKind): void;
  hide(): void;
  /** Validate the live choice, latch a relic vote and lower the button before input commits. */
  commit(): boolean;
  dispose(): void;
  readonly state: StreamConfirmState;
}

/** How deep the identity climb reads. */
const MAX_CLIMB = 16;

function pathLeaf(path: string | null | undefined): string {
  if (!path) return "";
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Which confirm-eligible kind an item is, from its granted groups (pure — the singleplayer relic is refused by name).
 */
export function confirmKindFor(meta: Pick<ItemMeta, "groups" | "path">): ConfirmTapKind | null {
  if (meta.groups.includes(RS_GROUP_CARD_REWARD_CARD)) return "reward";
  if (meta.groups.includes(RS_GROUP_TREASURE_RELIC)) {
    return pathLeaf(meta.path) === SINGLEPLAYER_RELIC_HOLDER_NAME ? null : "relic";
  }
  if (meta.groups.includes(RS_GROUP_EVENT_OPTION)) return "event";
  if (meta.groups.includes(RS_GROUP_SHOP_ITEM)) return "shop";
  if (meta.groups.includes(RS_GROUP_REST_SITE)) return "rest";
  return null;
}

export function createConfirmTapExtension(): { extension: RenderStreamExtension; controller: ConfirmTapController } {
  // id → kind, from the last full/delta item_meta table (static identity).
  const items = new Map<number, ItemMeta>();
  let selectionActive = false;
  let visibleOptions = 0;
  let confirmedRelic: number | null = null;
  let query: ItemQuery | null = null;

  const state: StreamConfirmState = reactive({
    targetId: null,
    kind: null,
    belowOverlay: false,
    rect: null
  });

  function anchorRect(id: number): Rect | null {
    if (query === null) return null;
    return query.subtreeRect(id) ?? query.rect(id);
  }

  function meta(id: number): ItemMeta | null {
    return query?.meta(id) ?? items.get(id) ?? null;
  }

  function hasScene(id: number, suffix: string): boolean {
    let cur: number | null = id;
    for (let depth = 0; cur !== null && depth < MAX_CLIMB; depth++) {
      if (meta(cur)?.scene?.endsWith(suffix)) return true;
      cur = query?.parent(cur) ?? null;
    }
    return false;
  }

  function eligibleHit(id: number): ConfirmTapHit | null {
    const m = meta(id);
    if (query === null || m === null || selectionActive || !query.visible(id) || isCopiedItem(id, query)) return null;
    const kind = confirmKindFor(m);
    if (kind === null) return null;
    if (kind === "event" && (visibleOptions === 1 || hasScene(id, PROCEED_BUTTON_SCENE_FILE_SUFFIX))) return null;
    const types = itemTypes(m);
    const children = query.children(id);
    if (types.includes("NMerchantCardRemoval")) {
      if (!Array.from(children).some((child) => pathLeaf(meta(child)?.path) === "Cost" && query!.visible(child))) return null;
      return { id, kind, retapActivates: true };
    }
    if (types.includes("NBlitzMerchantSlot")) {
      if (Array.from(children).some((child) => pathLeaf(meta(child)?.path) === "Hitbox" && meta(child)?.mouseFilter === "ignore")) return null;
      const descendants = Array.from(children);
      while (descendants.length > 0) {
        const child = descendants.pop()!;
        if (pathLeaf(meta(child)?.path) === "Icon" && !query.visible(child)) return null;
        descendants.push(...query.children(child));
      }
    }
    return { id, kind };
  }

  /** A holder's Hitbox stands for the one reward card beside it, never an ambiguous row of cards. */
  function rewardCardBeside(hitItem: number, q: ItemQuery): ConfirmTapHit | null {
    const parent = q.parent(hitItem);
    if (parent === null) return null;
    let card: ConfirmTapHit | null = null;
    for (const id of q.children(parent)) {
      if (id === hitItem) continue;
      const candidate = eligibleHit(id);
      if (candidate?.kind !== "reward") continue;
      if (card !== null) return null;
      card = candidate;
    }
    return card;
  }

  function sameRect(a: Rect | null, b: Rect | null): boolean {
    if (a === null || b === null) return a === b;
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }

  const controller: ConfirmTapController = {
    classify(hitItem) {
      if (query === null || selectionActive || isCopiedItem(hitItem, query)) return null;
      let cur: number | null = hitItem;
      for (let depth = 0; cur !== null && depth < MAX_CLIMB; depth++) {
        const m = meta(cur);
        if (m?.scene?.endsWith(PROCEED_BUTTON_SCENE_FILE_SUFFIX)) return null;
        if (m !== null && confirmKindFor(m) !== null) return eligibleHit(cur);
        cur = query.parent(cur);
      }
      return rewardCardBeside(hitItem, query);
    },
    show(id, kind) {
      if (eligibleHit(id)?.kind !== kind || (kind === "relic" && id === confirmedRelic)) {
        controller.hide();
        return;
      }
      state.targetId = id;
      state.kind = kind;
      state.belowOverlay = false;
      state.rect = anchorRect(id);
    },
    hide() {
      state.targetId = null;
      state.kind = null;
      state.belowOverlay = false;
      state.rect = null;
    },
    commit() {
      const id = state.targetId;
      if (id === null || state.belowOverlay || eligibleHit(id) === null || (state.kind === "relic" && id === confirmedRelic)) {
        controller.hide();
        return false;
      }
      if (state.kind === "relic") confirmedRelic = id;
      controller.hide();
      return true;
    },
    dispose() {
      items.clear();
      confirmedRelic = null;
      query = null;
      state.targetId = null;
      state.kind = null;
      state.belowOverlay = false;
      state.rect = null;
    },
    state
  };

  const extension: RenderStreamExtension = {
    id: "couchcoop.confirmTap",
    wants: { fields: ["path", "class", "script", "scene", "mouse_filter"], groups: [...CONFIRM_TAP_GROUPS] },
    onItemMeta: (b) => {
      if (b.form === "full") items.clear();
      for (const m of b.items) items.set(m.id, m);
      if (confirmedRelic !== null && !items.has(confirmedRelic)) confirmedRelic = null;
    },
    onItemsRemoved: (ids) => {
      for (const id of ids) items.delete(id);
      if (confirmedRelic !== null && !items.has(confirmedRelic)) confirmedRelic = null;
      if (state.targetId !== null && !items.has(state.targetId)) controller.hide();
    },
    beforeDraw: (f) => {
      query = f.query;
      selectionActive = false;
      visibleOptions = 0;
      for (const [id, m] of items) {
        if (!query.visible(id)) continue;
        if (isCardSelection(m)) selectionActive = true;
        if (m.groups.includes(RS_GROUP_EVENT_OPTION) || itemTypes(m).includes("NEventOptionButton")) visibleOptions++;
      }
      if (state.targetId !== null && eligibleHit(state.targetId) === null) controller.hide();
      // While the button is up, follow the widget (its focus growth, a shop shelf sliding in): the rect is re-read
      // per drawn frame and written only when it moved, so an idle button costs no reactive churn.
      if (state.targetId !== null) {
        const rect = anchorRect(state.targetId);
        if (!sameRect(rect, state.rect)) state.rect = rect;
        const box = query.rect(state.targetId) ?? rect;
        let top: number | null = null;
        if (box !== null) {
          // Rects describe game state; hitTest reads the drawn picture, including ancestor overrides.
          const [a, b, c, d, tx, ty] = f.overrides.effective(state.targetId);
          const x = box.x + box.w / 2;
          const y = box.y + box.h / 2;
          top = query.hitTest(a * x + c * y + tx, b * x + d * y + ty);
        }
        state.belowOverlay = top !== null && controller.classify(top)?.id !== state.targetId;
      }
    },
    dispose: () => controller.dispose()
  };

  return { extension, controller };
}
