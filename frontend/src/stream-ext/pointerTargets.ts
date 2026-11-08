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

export function createPointerTargetModule(): PointerTargetModule {
  const resolvers = new WeakMap<RenderStreamClient, RenderStreamPointerTargetResolver | null>();
  const extension: RenderStreamExtension = {
    id: "couchcoop.pointerTargets",
    wants: { fields: ["scene", "path", "instance_id", "mouse_filter"], groups: [...POINTER_TARGET_GROUPS] }
  };

  return {
    extension,
    climb: climbToTarget,
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
