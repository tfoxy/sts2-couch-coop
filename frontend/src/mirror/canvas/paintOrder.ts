// PAINT ORDER for the single-canvas mirror stage — the ordered DFS a draw list is emitted along.
//
// A draw list is FLAT and ORDERED: whatever is pushed later paints later. The DOM backend never had to compute
// that order, because the browser did it (DOM order + `z-index` + stacking contexts). This module computes it
// explicitly, and it is the ONE place that knows Godot's three sibling rules:
//
//   1. `show_behind_parent` children draw BEFORE the parent's own paint; every other child draws AFTER it.
//   2. Within each of those two groups, siblings are ordered by `z_index` ASCENDING, and the sort is STABLE — an
//      equal-z run keeps the producer's own child order, which is what preserves intra-card stacking and the
//      normal hand-fan overlap. (`Array.prototype.sort` has been required to be stable since ES2019; the spec
//      suite pins it, because the whole ordering rests on it.)
//   3. `z_index` is RELATIVE (Godot's `z_as_relative`, which is what the producer streams and what the DOM
//      backend emits verbatim as a CSS `z-index` on a transformed — i.e. already stacking-context — element).
//      A raised child is lifted above its SIBLINGS, never above anything outside its parent.
//
// So one node's emission is `[behind children's subtrees…] self [front children's subtrees…]`, and rule 3 gives
// the invariant the rest of the canvas stage is built on:
//
//   THE CONTIGUITY INVARIANT — a node's subtree occupies a CONTIGUOUS interval `[spanStart, spanEnd)` of the
//   flat order. Nothing outside the subtree can be scheduled inside that interval, because the only reordering
//   force (z) is confined to one parent's child list. That is what makes a clip scope expressible as a single
//   `clipPush` … `clipPop` pair around an interval instead of as per-command state, and it is asserted (in dev
//   and under the offline gate) rather than assumed — see `assertContiguousSpans`.
//
// DIVERGENCE FROM TODAY'S DOM BACKEND, ON PURPOSE. `mirrorRenderer`'s `buildPaintOrderIndex` indexes
// `state.orderedIds` verbatim: the producer's pre-order DFS, with NO z sort and NO behind-parent lift (the
// browser applies both at paint time, so the renderer's *index* never had to). Every consumer of that index is a
// hit-test tiebreak, where the approximation is cheap. This module is the more correct one, and the divergence is
// pre-registered: probe P4 measured its size at 0-3 z-index nodes and 4-65 `show_behind_parent` nodes per screen
// (docs/agents/canvas-stage-probes-aug26.md).
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only, no DOM, no gsw.

import { isOrphanNode, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

/** The roots' key in the per-parent maps below. `null` is a real Map key, so no sentinel string is needed. */
type ParentKey = string | null;

/** One node's place in the flat emission order. */
export interface PaintOrderEntry {
  id: string;
  /** Index of the node's OWN paint in {@link PaintOrder.ids}. */
  order: number;
  /** First index of the node's whole subtree span (its first behind-child's span start, or `order`). */
  spanStart: number;
  /** One past the last index of the subtree span. `spanEnd - spanStart` is the subtree's node count. */
  spanEnd: number;
  /** Depth below the stage root (roots are 0). */
  depth: number;
  /** The parent this node was ordered under, or null when it was ordered as a stage root. */
  parentId: string | null;
}

/** One built order. Immutable; a rebuild returns a new one (the cache below is what survives). */
export interface PaintOrder {
  /** Node ids in emission order: index `i` paints before index `i + 1`. */
  readonly ids: readonly string[];
  readonly entries: ReadonlyMap<string, PaintOrderEntry>;
  /** The stage roots, in emission order. */
  readonly rootIds: readonly string[];
  /** `id`'s own paint index, or -1 when the node is not in this order. */
  orderOf(id: string): number;
  /** `parentId`'s children in emission order (behind group first, then the front group). */
  childrenOf(parentId: ParentKey): readonly string[];
  /** How many of {@link PaintOrder.childrenOf}'s leading entries are `show_behind_parent`. */
  behindCountOf(parentId: ParentKey): number;
}

/** What one build reused vs recomputed — the cache's own probe (see {@link PaintOrderCache}). */
export interface PaintOrderCacheStats {
  /** Full rebuilds: every sibling sort dropped (a new `orderedIds` reference / an explicit invalidation). */
  rebuilds: number;
  /** Sibling arrays SORTED this build (a cache miss). */
  sortedParents: number;
  /** Sibling arrays taken from the cache unchanged. */
  reusedParents: number;
  /** Sibling arrays dropped by a z / show-behind change on one of their children. */
  invalidatedParents: number;
}

/**
 * The reusable half of a build: the per-parent SORTED SIBLING ARRAYS.
 *
 * Sorting is the only superlinear work in the walk, and it is a pure function of one parent's child list plus its
 * children's `z_index` / `show_behind_parent`. Both signals are things the reconciler already computes:
 *
 *   * STRUCTURAL — `state.orderedIds` gets a NEW ARRAY REFERENCE exactly when the child structure changed
 *     (`applySceneDelta` replaces it wholesale, rebuilds it from an order patch, or re-slices it for the R10
 *     late-node guard). That is the same signal `mirrorRenderer` selects its structural walk on, so the two can
 *     never disagree about what "the tree moved" means. Detected here, automatically, on every build.
 *   * Z — a node whose `z_index` or `show_behind_parent` changed arrives in `state.changedIds`. Feed those to
 *     {@link PaintOrderCache.noteChanged} BEFORE the build (the reconciler drains that set) and only the affected
 *     parents' sorts are dropped.
 *
 * A cache is optional: `buildPaintOrder(state)` with no cache sorts everything, which is what the offline gate and
 * the specs do.
 */
export interface PaintOrderCache {
  /** Drop every sibling sort (a keyframe, a backend swap, a test reset). */
  invalidateAll(): void;
  /** Drop ONE parent's sibling sort (a child's z / show-behind moved, or its child list did). */
  invalidateParent(parentId: ParentKey): void;
  /**
   * Fold the reconciler's `changedIds` in: any changed node whose `z_index`, `show_behind_parent` or `parentId`
   * differs from what the cache last recorded invalidates the sort of the parent it is under (and of the parent it
   * came from). Returns how many sibling sorts were dropped.
   */
  noteChanged(state: MirrorState, changedIds: Iterable<string>): number;
  readonly stats: Readonly<PaintOrderCacheStats>;
}

interface SortedKids {
  ids: string[];
  behind: number;
}

interface ChildSignature {
  parentId: string | null;
  z: number;
  behind: boolean;
}

interface InternalCache extends PaintOrderCache {
  sorted: Map<ParentKey, SortedKids>;
  sig: Map<string, ChildSignature>;
  lastOrderedIds: readonly string[] | null;
  mutableStats: PaintOrderCacheStats;
}

export function createPaintOrderCache(): PaintOrderCache {
  const sorted = new Map<ParentKey, SortedKids>();
  const sig = new Map<string, ChildSignature>();
  const mutableStats: PaintOrderCacheStats = {
    rebuilds: 0,
    sortedParents: 0,
    reusedParents: 0,
    invalidatedParents: 0
  };
  const cache: InternalCache = {
    sorted,
    sig,
    lastOrderedIds: null,
    mutableStats,
    get stats() {
      return mutableStats;
    },
    invalidateAll() {
      sorted.clear();
      sig.clear();
      cache.lastOrderedIds = null;
      mutableStats.rebuilds++;
    },
    invalidateParent(parentId: ParentKey) {
      if (sorted.delete(parentId)) {
        mutableStats.invalidatedParents++;
      }
    },
    noteChanged(state: MirrorState, changedIds: Iterable<string>): number {
      let dropped = 0;
      const drop = (parentId: ParentKey): void => {
        if (sorted.delete(parentId)) {
          mutableStats.invalidatedParents++;
          dropped++;
        }
      };
      for (const id of changedIds) {
        const node = state.nodes.get(id);
        const previous = sig.get(id);
        if (!node) {
          // Removed: its former parent's child list is short one entry.
          if (previous) {
            drop(previous.parentId);
            sig.delete(id);
          }
          continue;
        }
        const next = signatureOf(node, state.nodes);
        if (previous && sameSignature(previous, next)) {
          continue;
        }
        if (previous && previous.parentId !== next.parentId) {
          drop(previous.parentId); // a reparent dirties BOTH lists
        }
        drop(next.parentId);
        sig.set(id, next);
      }
      return dropped;
    }
  };
  return cache;
}

function signatureOf(node: MirrorNode, nodes: Map<string, MirrorNode>): ChildSignature {
  return {
    // An ORPHAN is ordered as a stage ROOT (see `orderParent`), so that — not its dangling `parentId` — is the
    // list its z participates in.
    parentId: orderParent(node, nodes),
    z: node.zIndex ?? 0,
    behind: node.showBehindParent === true
  };
}

function sameSignature(a: ChildSignature, b: ChildSignature): boolean {
  return a.parentId === b.parentId && a.z === b.z && a.behind === b.behind;
}

/**
 * Which list a node is ordered in: its parent when that parent is LIVE in the map, else the stage roots.
 *
 * This is the rule `sceneTree.buildOrderStructure`, `mirrorRenderer.rebuildStructure` and the offline
 * `walkResolved` all apply, restated once here (an orphan — a node naming a parent the map does not hold — orders
 * as a root; `isOrphanNode` is exported by sceneTree so the three can never drift on what one IS).
 */
function orderParent(node: MirrorNode, nodes: Map<string, MirrorNode>): string | null {
  return node.parentId != null && !isOrphanNode(node, nodes) ? node.parentId : null;
}

export interface BuildPaintOrderOptions {
  /**
   * Check {@link PaintOrder}'s contiguity invariant after the walk. Defaults to {@link paintOrderAssertsOn} — on in
   * a dev build, in vitest and under the offline gate; off in a production bundle, where the walk is hot.
   */
  assert?: boolean;
}

/**
 * DEV/TEST assertion default: on everywhere except a production browser bundle.
 *
 * `import.meta.env` exists under Vite (dev + build) and is absent under bare Node, which is exactly the split we
 * want: the offline gate and vitest get the checks, the shipped bundle does not.
 */
export function paintOrderAssertsOn(): boolean {
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  return env && typeof env.DEV === "boolean" ? env.DEV : true;
}

/** Build the flat emission order for `state`. `cache` is optional (see {@link PaintOrderCache}). */
export function buildPaintOrder(
  state: MirrorState,
  cache?: PaintOrderCache,
  options: BuildPaintOrderOptions = {}
): PaintOrder {
  const internal = cache as InternalCache | undefined;
  if (internal && internal.lastOrderedIds !== state.orderedIds) {
    // STRUCTURAL: the child structure moved, so every sibling list is suspect. Recorded before the walk so a throw
    // below cannot leave the cache claiming to describe an order it never built.
    internal.sorted.clear();
    internal.sig.clear();
    internal.mutableStats.rebuilds++;
    internal.lastOrderedIds = state.orderedIds;
  }

  const nodes = state.nodes;
  // (rootIds, childIdsByParent) in the producer's own child order — the same structure `sceneTree` rebuilds from a
  // Stage-4 order patch, and the input the z/behind sort permutes.
  const rawKids = new Map<ParentKey, string[]>();
  const rootIds: string[] = [];
  rawKids.set(null, rootIds);
  for (const id of state.orderedIds) {
    const node = nodes.get(id);
    if (!node) {
      continue; // ordered but not live (a removal the order has not caught up with)
    }
    const parentId = orderParent(node, nodes);
    let list = rawKids.get(parentId);
    if (!list) {
      list = [];
      rawKids.set(parentId, list);
    }
    list.push(id);
  }

  const sortedKids = new Map<ParentKey, SortedKids>();
  const sortFor = (parentId: ParentKey): SortedKids => {
    const raw = rawKids.get(parentId);
    if (!raw || raw.length === 0) {
      return EMPTY_SORTED; // a LEAF — the overwhelming majority. No cache traffic, no allocation, no counter.
    }
    const cached = internal?.sorted.get(parentId);
    if (cached && sameIdList(cached.ids, raw)) {
      // Same members ⇒ the recorded sort is still a permutation of this list. (A child list that changed SHAPE
      // gets a fresh `orderedIds` reference, which cleared the cache above; this compare is the belt.)
      if (internal) {
        internal.mutableStats.reusedParents++;
      }
      return cached;
    }
    const result = sortSiblings(raw, nodes);
    if (internal) {
      internal.sorted.set(parentId, result);
      internal.mutableStats.sortedParents++;
      for (const id of result.ids) {
        const node = nodes.get(id);
        if (node) {
          internal.sig.set(id, signatureOf(node, nodes));
        }
      }
    }
    return result;
  };

  const ids: string[] = [];
  const entries = new Map<string, PaintOrderEntry>();
  const seen = new Set<string>();

  const walk = (id: string, parentId: string | null, depth: number): void => {
    if (seen.has(id)) {
      return; // a cycle in the streamed parent links: emit each node exactly once
    }
    seen.add(id);
    const spanStart = ids.length;
    const kids = sortFor(id);
    if (kids !== EMPTY_SORTED) {
      sortedKids.set(id, kids);
    }
    for (let i = 0; i < kids.behind; i++) {
      walk(kids.ids[i], id, depth + 1);
    }
    const order = ids.length;
    ids.push(id);
    for (let i = kids.behind; i < kids.ids.length; i++) {
      walk(kids.ids[i], id, depth + 1);
    }
    entries.set(id, { id, order, spanStart, spanEnd: ids.length, depth, parentId });
  };

  const roots = sortFor(null);
  if (roots !== EMPTY_SORTED) {
    sortedKids.set(null, roots);
  }
  for (const id of roots.ids) {
    walk(id, null, 0);
  }

  const order: PaintOrder = {
    ids,
    entries,
    rootIds: roots.ids,
    orderOf(id: string): number {
      return entries.get(id)?.order ?? -1;
    },
    childrenOf(parentId: ParentKey): readonly string[] {
      return sortedKids.get(parentId)?.ids ?? EMPTY_IDS;
    },
    behindCountOf(parentId: ParentKey): number {
      return sortedKids.get(parentId)?.behind ?? 0;
    }
  };

  if (options.assert ?? paintOrderAssertsOn()) {
    assertContiguousSpans(order);
  }
  return order;
}

const EMPTY_IDS: readonly string[] = Object.freeze([]);
/** The shared "this node has no children" answer — leaves never touch the cache or allocate. */
const EMPTY_SORTED: SortedKids = Object.freeze({ ids: [] as string[], behind: 0 }) as SortedKids;

/**
 * One parent's children in emission order: the `show_behind_parent` group (stably sorted by z) followed by the
 * front group (stably sorted by z).
 *
 * A node that is not live in the map is dropped, as it is everywhere else in the structure builders.
 */
function sortSiblings(raw: readonly string[], nodes: Map<string, MirrorNode>): SortedKids {
  if (raw.length === 0) {
    return { ids: [], behind: 0 };
  }
  const behind: string[] = [];
  const front: string[] = [];
  let anyZ = false;
  for (const id of raw) {
    const node = nodes.get(id);
    if (!node) {
      continue;
    }
    if ((node.zIndex ?? 0) !== 0) {
      anyZ = true;
    }
    (node.showBehindParent === true ? behind : front).push(id);
  }
  if (anyZ) {
    // STABLE by contract (ES2019+): an equal-z run keeps the producer's order, which is the whole reason the
    // comparator is a bare subtraction and never a tiebreak on id. Skipped entirely when every sibling is at z 0,
    // which probe P4 measured as all but 0-3 nodes per screen.
    const byZ = (a: string, b: string): number => (nodes.get(a)?.zIndex ?? 0) - (nodes.get(b)?.zIndex ?? 0);
    behind.sort(byZ);
    front.sort(byZ);
  }
  const ids = behind.length === 0 ? front : behind.concat(front);
  return { ids, behind: behind.length };
}

function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  // The cached array is SORTED and the raw one is not, so compare as SETS: same members ⇒ the recorded permutation
  // is still a permutation of this list. (Order changes come with a fresh `orderedIds`, handled above.)
  const seen = new Set(b);
  for (const id of a) {
    if (!seen.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * THE CONTIGUITY INVARIANT, checked: every node's `[spanStart, spanEnd)` holds exactly its subtree, its own paint
 * sits inside it, and a child's span is nested inside its parent's.
 *
 * If this ever fires, the single-canvas stage's clip model is invalid — a clip scope would have to become
 * per-command state instead of a `clipPush`/`clipPop` pair. Throwing is therefore the right response: the wrong
 * picture would be silent, and this is not.
 */
export function assertContiguousSpans(order: PaintOrder): void {
  const counts = new Map<string, number>();
  for (const entry of order.entries.values()) {
    let n = 1;
    for (const kid of order.childrenOf(entry.id)) {
      const kidEntry = order.entries.get(kid);
      if (!kidEntry) {
        continue;
      }
      if (kidEntry.spanStart < entry.spanStart || kidEntry.spanEnd > entry.spanEnd) {
        throw new Error(
          `[paintOrder] child ${kid} span [${kidEntry.spanStart},${kidEntry.spanEnd}) escapes parent ${entry.id} ` +
            `span [${entry.spanStart},${entry.spanEnd}) — z cannot cross a parent boundary`
        );
      }
      n += kidEntry.spanEnd - kidEntry.spanStart;
    }
    counts.set(entry.id, n);
    if (entry.order < entry.spanStart || entry.order >= entry.spanEnd) {
      throw new Error(`[paintOrder] node ${entry.id} paints at ${entry.order}, outside its own span`);
    }
  }
  for (const entry of order.entries.values()) {
    const expected = counts.get(entry.id) ?? 0;
    const actual = entry.spanEnd - entry.spanStart;
    if (expected !== actual) {
      throw new Error(
        `[paintOrder] node ${entry.id} span holds ${actual} ids but its subtree has ${expected} — the interval is ` +
          `not contiguous`
      );
    }
  }
}
