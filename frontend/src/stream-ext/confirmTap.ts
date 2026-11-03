// stream-ext/confirmTap.ts — the render-stream client's CONFIRM-TAP module (the stream's `confirmTap` setting).
//
// The old mirror's client confirm button (mirror/confirmTap.ts + MirrorConfirmButton.vue), re-anchored to the
// streaming seat: on the screens where a tap CONSUMES a run reward — card rewards, event options, shop purchases,
// multiplayer treasure relics, rest-site choices — a tap only ever FOCUSES, and a DOM confirm button commits it.
// The classification is group-based here instead of node-type-based: the mod tags each confirm-eligible widget with
// its own `item_meta` group, and this module climbs from the hit item (a widget's CHILD) to that widget.
//
// The DOM button is couch product UI (RenderStreamStage renders it); this module only classifies and holds the
// button's live state — the target widget, its kind and its presentation-space rect for anchoring (the stage maps
// that rect through the client's `presentationToCss`). Nothing here reaches the game: the commit is a plain left
// click re-sent at the coordinate the focus hover already went to, owned by the input channel.

import type { ItemMeta, ItemMetaBatch, ItemQuery, Rect, RenderStreamExtension } from "@godot-scene-web/render-stream-client";
import { reactive } from "vue";

import type { ConfirmTapKind } from "@/mirror/confirmTap";
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
  /** The widget's presentation-space rect, for anchoring the button. */
  rect: Rect | null;
}

export interface ConfirmTapHit {
  readonly id: number;
  readonly kind: ConfirmTapKind;
}

export interface ConfirmTapController {
  /** The confirm-eligible widget this drawn item belongs to (a widget's child), or null. */
  classify(hitItem: number): ConfirmTapHit | null;
  /** Raise the button for a classified widget (a refused show is a hide). */
  show(id: number, kind: ConfirmTapKind): void;
  hide(): void;
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
  const eligible = new Map<number, ConfirmTapKind>();
  let query: ItemQuery | null = null;

  const state: StreamConfirmState = reactive({
    targetId: null,
    kind: null,
    rect: null
  });

  function anchorRect(id: number): Rect | null {
    if (query === null) return null;
    return query.subtreeRect(id) ?? query.rect(id);
  }

  function sameRect(a: Rect | null, b: Rect | null): boolean {
    if (a === null || b === null) return a === b;
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }

  const controller: ConfirmTapController = {
    classify(hitItem) {
      if (query === null) return null;
      let cur: number | null = hitItem;
      for (let depth = 0; cur !== null && depth < MAX_CLIMB; depth++) {
        const kind = eligible.get(cur);
        if (kind !== undefined) return { id: cur, kind };
        cur = query.parent(cur);
      }
      return null;
    },
    show(id, kind) {
      state.targetId = id;
      state.kind = kind;
      state.rect = anchorRect(id);
    },
    hide() {
      state.targetId = null;
      state.kind = null;
      state.rect = null;
    },
    dispose() {
      eligible.clear();
      query = null;
      state.targetId = null;
      state.kind = null;
      state.rect = null;
    },
    state
  };

  const extension: RenderStreamExtension = {
    id: "couchcoop.confirmTap",
    wants: { fields: ["path"], groups: [...CONFIRM_TAP_GROUPS] },
    onItemMeta: (b) => {
      if (b.form === "full") eligible.clear();
      for (const m of b.items) {
        const kind = confirmKindFor(m);
        if (kind === null) eligible.delete(m.id);
        else eligible.set(m.id, kind);
      }
    },
    onItemsRemoved: (ids) => {
      for (const id of ids) eligible.delete(id);
      if (state.targetId !== null && !eligible.has(state.targetId)) controller.hide();
    },
    beforeDraw: (f) => {
      query = f.query;
      // While the button is up, follow the widget (its focus growth, a shop shelf sliding in): the rect is re-read
      // per drawn frame and written only when it moved, so an idle button costs no reactive churn.
      if (state.targetId !== null) {
        const rect = anchorRect(state.targetId);
        if (!sameRect(rect, state.rect)) state.rect = rect;
      }
    },
    dispose: () => controller.dispose()
  };

  return { extension, controller };
}
