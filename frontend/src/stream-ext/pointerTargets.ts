// Resolve host-picked Controls to pointer targets, retaining couch role groups for the fallback climb.
// Host mouse filters select Godot tree order in GSW; couch makes no filter or pick-order statements.

import {
  pointerTargetResolver,
  type ItemMeta,
  type ItemQuery,
  type RenderStreamClient,
  type RenderStreamExtension,
  type RenderStreamPointerTargetResolver
} from "@godot-scene-web/render-stream-client";

import {
  POINTER_TARGET_GROUPS,
  RS_GROUP_CARD_REWARD_CARD,
  RS_GROUP_EVENT_OPTION,
  RS_GROUP_HAND_HOLDER,
  RS_GROUP_REST_SITE,
  RS_GROUP_SHOP_ITEM,
  RS_GROUP_TREASURE_RELIC
} from "@/stream-ext/groups";
import {
  CARD_GRID_SELECTION_SCREEN_TYPE,
  DECK_CARD_SELECT_SCREEN_TYPE,
  ECHO_CONTAINER,
  MULTIPLAYER_PLAYER_STATE_SCENE_FILE,
  PROCEED_BUTTON_SCENE_FILE_SUFFIX,
  TOUCH_TARGET_TYPES,
  isBlockingButtonType,
  isScrollbarBlockType
} from "@/mirror/renderer/interactionPolicy";
import type { RewardFocusSnapshot } from "@/mirror/renderer/contracts";

/** How deep the identity climb reads (a card art's child → card → holder is a few steps). */
const MAX_CLIMB = 16;

/** The roles the climb stops at. */
const ROLE_GROUPS: readonly string[] = [
  RS_GROUP_HAND_HOLDER,
  RS_GROUP_CARD_REWARD_CARD,
  RS_GROUP_TREASURE_RELIC,
  RS_GROUP_EVENT_OPTION,
  RS_GROUP_SHOP_ITEM,
  RS_GROUP_REST_SITE
];

export interface PointerTargetModule {
  readonly extension: RenderStreamExtension;
  /** Couch's identity climb: the item a hit stands for, or null for "no target". */
  climb(hit: number, query: ItemQuery): number | null;
  /** The target resolver over a client (one per client), or null when the client cannot resolve. */
  resolverFor(client: RenderStreamClient | null): RenderStreamPointerTargetResolver | null;
  /** The hover-first widget owning a hit, rather than the leaf Control that accepts its input. */
  touchTargetFor(hit: number): number | null;
  subscribeRewardFocus(listener: (snapshot: RewardFocusSnapshot) => void): () => void;
  isEndTurn(hit: number): boolean;
}

function typeLeaf(value: string | null | undefined): string {
  return value?.replace(/\.cs$/, "").split(/[/.+]/).pop() ?? "";
}

export function itemTypes(meta: ItemMeta | null): string[] {
  return [typeLeaf(meta?.class), typeLeaf(meta?.script)];
}

/** Whether the hit belongs to a copied preview/inspect card rather than an interactive choice. */
export function isCopiedItem(hit: number, query: ItemQuery): boolean {
  let cur: number | null = hit;
  for (let depth = 0; cur !== null && depth < MAX_CLIMB; depth++) {
    if (itemTypes(query.meta(cur)).some((type) => ECHO_CONTAINER.test(type))) return true;
    cur = query.parent(cur);
  }
  return false;
}

export function isCardSelection(meta: ItemMeta | null): boolean {
  return itemTypes(meta).some((type) => type === CARD_GRID_SELECTION_SCREEN_TYPE || type === DECK_CARD_SELECT_SCREEN_TYPE);
}

/** The same hover-first families as the node mirror, resolved through streamed identity. */
export function touchTargetFor(hit: number, query: ItemQuery, loneEventOption = false): number | null {
  if (isCopiedItem(hit, query)) return null;
  let cur: number | null = hit;
  let target: number | null = null;
  for (let depth = 0; cur !== null && depth < MAX_CLIMB; depth++) {
    const meta = query.meta(cur);
    if (isCardSelection(meta) && query.visible(cur)) return null;
    if (target === null) {
      if (meta?.scene?.endsWith(PROCEED_BUTTON_SCENE_FILE_SUFFIX)) return null;
      const leaves = itemTypes(meta);
      if (loneEventOption && (leaves.includes("NEventOptionButton") || meta?.groups.includes(RS_GROUP_EVENT_OPTION))) return null;
      if (leaves.some((type) => TOUCH_TARGET_TYPES.has(type)) || hasRole(meta)) target = cur;
      else if (meta?.scene === MULTIPLAYER_PLAYER_STATE_SCENE_FILE && meta.path === ".") target = cur;
      else if (leaves.some((type) => isBlockingButtonType(type) || isScrollbarBlockType(type))) return null;
    }
    cur = query.parent(cur);
  }
  if (target !== null) return target;
  // A reward holder's picked Hitbox is beside its card, rather than inside it. Never guess among multiple cards.
  const parent = query.parent(hit);
  if (parent === null) return null;
  let card: number | null = null;
  for (const sibling of query.children(parent)) {
    if (!query.meta(sibling)?.groups.includes(RS_GROUP_CARD_REWARD_CARD)) continue;
    if (card !== null) return null;
    card = sibling;
  }
  return card;
}

function hasRole(meta: ItemMeta | null): boolean {
  if (meta === null) return false;
  for (const g of meta.groups) if (ROLE_GROUPS.includes(g)) return true;
  return false;
}

/** The climb, pure over the query (the module's index is the query's own `meta`). */
export function climbToTarget(hit: number, query: ItemQuery): number | null {
  const hitMeta = query.meta(hit);
  if (hitMeta?.mouseFilter === "stop" || hitMeta?.mouseFilter === "pass") {
    return hasIdentity(hitMeta) ? hit : null;
  }
  let cur: number | null = hit;
  let firstNode: number | null = null;
  for (let depth = 0; cur !== null && depth < MAX_CLIMB; depth++) {
    const meta = query.meta(cur);
    if (hasRole(meta)) return cur;
    if (firstNode === null && meta?.node === true) firstNode = cur;
    cur = query.parent(cur);
  }
  if (firstNode === null) return null;
  return hasIdentity(query.meta(firstNode)) ? firstNode : null;
}

function hasIdentity(meta: ItemMeta | null): boolean {
  return Boolean(meta?.instanceId || (meta?.scene && meta.path));
}

/** Prefer the row's Hitbox, then its own Control, then another interactive descendant. */
function rewardCenter(id: number, query: ItemQuery): { x: number; y: number } | null {
  let center: { x: number; y: number } | null = null;
  let bestRank = Infinity;
  const visit = (item: number, depth: number): void => {
    if (depth >= MAX_CLIMB || !query.visible(item)) return;
    const meta = query.meta(item);
    const hitbox = meta?.path?.split("/").pop() === "Hitbox";
    if (hitbox || item === id || meta?.mouseFilter === "stop" || meta?.mouseFilter === "pass") {
      const box = query.rect(item);
      const rank = hitbox ? 0 : item === id ? 1 : 2;
      if (box !== null && box.w > 0 && box.h > 0 && rank < bestRank) {
        const x = box.x + box.w / 2;
        const y = box.y + box.h / 2;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          center = { x, y };
          bestRank = rank;
        }
      }
    }
    for (const child of query.children(item)) visit(child, depth + 1);
  };
  visit(id, 0);
  return center;
}

export function createPointerTargetModule(): PointerTargetModule {
  const resolvers = new WeakMap<RenderStreamClient, RenderStreamPointerTargetResolver | null>();
  let query: ItemQuery | null = null;
  const eventOptions = new Set<number>();
  const rewardItems = new Map<number, "screen" | "row">();
  const rewardListeners = new Set<(snapshot: RewardFocusSnapshot) => void>();
  let rewardSnapshot: RewardFocusSnapshot = { screenId: null, rows: [] };
  let rewardSeq: number | null = null;
  let loneEventOption = false;
  const extension: RenderStreamExtension = {
    id: "couchcoop.pointerTargets",
    wants: { fields: ["scene", "path", "instance_id", "mouse_filter", "class", "script"], groups: [...POINTER_TARGET_GROUPS] },
    onItemMeta(batch) {
      if (batch.form === "full") { eventOptions.clear(); rewardItems.clear(); rewardSeq = null; }
      for (const meta of batch.items) {
        if (meta.groups.includes(RS_GROUP_EVENT_OPTION) || itemTypes(meta).includes("NEventOptionButton")) eventOptions.add(meta.id);
        else eventOptions.delete(meta.id);
        const types = itemTypes(meta);
        if (types.includes("NRewardsScreen")) rewardItems.set(meta.id, "screen");
        else if (types.includes("NRewardButton")) rewardItems.set(meta.id, "row");
        else rewardItems.delete(meta.id);
      }
    },
    onItemsRemoved: (ids) => { for (const id of ids) { eventOptions.delete(id); rewardItems.delete(id); } },
    beforeDraw: (frame) => {
      query = frame.query;
      let visibleOptions = 0;
      for (const id of eventOptions) if (query.visible(id)) visibleOptions++;
      loneEventOption = visibleOptions === 1;
      // Reward focus follows accepted scene transactions, not extension redraws or a game-state poll.
      if (frame.seq === null || frame.seq === rewardSeq) return;
      rewardSeq = frame.seq;
      const screen = [...rewardItems].find(([id, role]) => role === "screen" && frame.query.visible(id))?.[0];
      const rows: RewardFocusSnapshot["rows"] = [];
      const visit = (id: number, depth: number): void => {
        if (depth >= MAX_CLIMB || !frame.query.visible(id)) return;
        if (rewardItems.get(id) === "row") {
          const gameCenter = rewardCenter(id, frame.query);
          let covered = false;
          if (gameCenter !== null) {
            const [a, b, c, d, tx, ty] = frame.overrides.effective(id);
            const top = frame.query.hitTest(a * gameCenter.x + c * gameCenter.y + tx, b * gameCenter.x + d * gameCenter.y + ty);
            covered = top !== null && touchTargetFor(top, frame.query) !== id;
          }
          rows.push({ id: String(id), focused: false, covered, gameCenter });
          return;
        }
        for (const child of frame.query.children(id)) visit(child, depth + 1);
      };
      if (screen !== undefined) visit(screen, 0);
      rewardSnapshot = { screenId: screen === undefined ? null : String(screen), rows };
      for (const listener of rewardListeners) listener(rewardSnapshot);
    },
    dispose: () => { query = null; eventOptions.clear(); rewardItems.clear(); rewardListeners.clear(); }
  };

  return {
    extension,
    climb: climbToTarget,
    subscribeRewardFocus(listener) {
      rewardListeners.add(listener);
      listener(rewardSnapshot);
      return () => { rewardListeners.delete(listener); };
    },
    touchTargetFor: (hit) => query === null ? null : touchTargetFor(hit, query, loneEventOption),
    isEndTurn(hit) {
      let cur: number | null = hit;
      for (let depth = 0; query !== null && cur !== null && depth < MAX_CLIMB; depth++) {
        const meta = query.meta(cur);
        if (meta?.scene?.endsWith("end_turn_button.tscn") || itemTypes(meta).includes("NEndTurnButton")) return true;
        cur = query.parent(cur);
      }
      return false;
    },
    resolverFor(client) {
      if (client === null) return null;
      if (resolvers.has(client)) return resolvers.get(client) ?? null;
      let resolver: RenderStreamPointerTargetResolver | null = null;
      try {
        resolver = pointerTargetResolver(client, { climb: climbToTarget });
      } catch {
        resolver = null; // not a real client (a spec's fake): no targets
      }
      resolvers.set(client, resolver);
      return resolver;
    }
  };
}
