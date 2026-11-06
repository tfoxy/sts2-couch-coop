// stream-ext/pointerTargets.ts — the render-stream client's POINTER-TARGET module (GSW input plan row C3).
//
// Two jobs, both about which node the viewer's pointer is on, as the stream DREW it:
//
//   * MOUSE FILTERS. The seat tags every Control that takes pointer input (`couchcoop_rs_pointer_input`,
//     RenderStreamItemTagger). This module states each node item's Godot mouse filter to the client's hit test
//     (`ExtensionSession.mouseFilter`): tagged, or a role widget = "stop", any other node = "ignore" (an IGNORE
//     Control, or a Node2D, which Godot's GUI never stops at); an item with no node, or whose identity has not
//     arrived, keeps none (counts as drawn). The client then picks as Godot would, as far as drawn items tell (godot-scene-web HIT1): an IGNORE
//     item stands for its nearest input ancestor, or lets the point through when it has none. Without it the game's
//     full-screen transition rect (drawn on top of everything, transparent through its shader, mouse_filter IGNORE)
//     was the topmost drawn item at every point of the combat screen: `clientToGame` named it everywhere, so no
//     override inverse applied, no hand card could be peeked and no confirm widget was ever found. Background
//     layers and particles drawn over the UI hid buttons the same way.
//   * IDENTITY CLIMB. The target resolver (`pointerTargetResolver` from godot-scene-web) asks `climb(hit, query)`
//     which node a hit item stands for. Couch's answer resolves the CARD, not its label: from the topmost drawn item
//     up to a hand card's holder (`couchcoop_rs_hand_holder`) or a confirm-eligible widget (card reward, treasure
//     relic, event option, shop item, rest site); otherwise the first item that is a node, and only when the seat
//     granted it an identity (scene + path). An item with no identity is no target (the coordinate path).
//
// The identity the resolver returns (scene + path, render-stream `item_meta`) and the point in that node's own
// coordinates ride couch's `hover`/`click` messages (streamInput.ts), and the seat keeps the coordinate when it still
// lands on that node, or moves it onto the node (C# PointerTargetPlacement, `retarget: "when-missed"`).
//
// Always part of an interactive page's extension list (RenderStreamStage), whatever modules the viewer enabled: the
// filters decide what every gesture and every coordinate sees. Nothing is stated when the seat did not grant the
// input group (no tag could then be read, and calling every node "ignore" would let every point through). A
// receive-only page never builds it.

import {
  pointerTargetResolver,
  type ExtensionSession,
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
  RS_GROUP_POINTER_INPUT,
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
  /** Items with a stated mouse filter (tests and diagnostics). */
  readonly filteredCount: number;
}

function hasRole(meta: ItemMeta | null): boolean {
  if (meta === null) return false;
  for (const g of meta.groups) if (ROLE_GROUPS.includes(g)) return true;
  return false;
}

/** The climb, pure over the query (the module's index is the query's own `meta`). */
export function climbToTarget(hit: number, query: ItemQuery): number | null {
  let cur: number | null = hit;
  let firstNode: number | null = null;
  for (let depth = 0; cur !== null && depth < MAX_CLIMB; depth++) {
    const meta = query.meta(cur);
    if (hasRole(meta)) return cur;
    if (firstNode === null && meta?.node === true) firstNode = cur;
    cur = query.parent(cur);
  }
  if (firstNode === null) return null;
  const meta = query.meta(firstNode);
  return meta?.scene && meta.path ? firstNode : null;
}

export function createPointerTargetModule(): PointerTargetModule {
  let session: ExtensionSession | null = null;
  /** Whether the seat granted the input group (else no filter is stated). */
  let granted = false;
  /** The filter this module stated per item (this session). */
  const stated = new Map<number, "stop" | "ignore">();
  const resolvers = new WeakMap<RenderStreamClient, RenderStreamPointerTargetResolver | null>();

  function filterOf(m: ItemMeta): "stop" | "ignore" | null {
    if (!m.node) return null;
    // A role widget (a hand card's holder, a confirm-eligible widget) is what the player points at by definition:
    // "stop" whatever its filter was when the seat read it (an event option turns STOP only once it is enabled).
    return m.groups.includes(RS_GROUP_POINTER_INPUT) || hasRole(m) ? "stop" : "ignore";
  }

  function state(id: number, filter: "stop" | "ignore" | null): void {
    if ((stated.get(id) ?? null) === filter) return;
    if (filter === null) stated.delete(id);
    else stated.set(id, filter);
    session?.mouseFilter(id, filter);
  }

  const extension: RenderStreamExtension = {
    id: "couchcoop.pointerTargets",
    wants: { fields: ["scene", "path"], groups: [...POINTER_TARGET_GROUPS] },
    onSession: (s) => {
      // A new session starts with no filter on the client's side too.
      session = s;
      granted = s.itemMeta?.groups.includes(RS_GROUP_POINTER_INPUT) === true;
      stated.clear();
      // Draw order on purpose, not Godot's tree order (`s.pickOrder("tree")`, godot-scene-web ID2): the filters
      // here are read once, when a node is ready, and tree order also answers undrawn and transparent Controls. So a
      // Control the game turns IGNORE later (the run's full-screen OverlayBackstop: STOP when ready, IGNORE and
      // alpha 0 once no overlay is open) would answer EVERY point. Measured live (C4a): every combat hover named it.
      // Tree order waits for filters the host keeps live (godot-scene-web Identity v2, couch row C4b).
    },
    onItemMeta: (batch) => {
      if (!granted) return;
      if (batch.form === "full") {
        const listed = new Set(batch.items.map((m) => m.id));
        for (const id of [...stated.keys()]) if (!listed.has(id)) state(id, null);
      }
      for (const m of batch.items) state(m.id, filterOf(m));
    },
    onItemsRemoved: (ids) => {
      // The client drops removed items' filters itself; only the mirror here needs it.
      for (const id of ids) stated.delete(id);
    },
    dispose: () => {
      stated.clear();
      session = null;
    }
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
    },
    get filteredCount() {
      return stated.size;
    }
  };
}
