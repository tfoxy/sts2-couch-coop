// Pure structural diff for the mirror renderer's INCREMENTAL structural walks: given the previous walk's
// children-index (childIdsByParent + rootIds) and the freshly rebuilt one, compute which parents' child lists
// actually changed and which nodes disappeared — so an orderedIds-changed delta (a reorder, a damage-number
// add/remove, a reparent) can keep dirty pruning + the skip-clean/fast-path machinery instead of falling back to
// a full un-pruned restyle walk of the whole (~19k node) scene. Self-contained: no imports, no DOM.

export interface StructureIndex {
  // parent id → ordered child ids (paint order). Built by the renderer's rebuildStructure from state.orderedIds.
  childIdsByParent: Map<string, string[]>;
  rootIds: string[];
}

export interface StructureDiffResult {
  // Parents whose NEW child id list differs from the old one (length or any element): a child was added, removed,
  // reordered or reparented under them — or they gained their first / lost their last child. These (plus the stage
  // when `rootsDirty`) are the only parents whose DOM child order can have changed, and the only ones whose
  // behindCount can have moved without their own node object changing.
  orderDirtyParents: Set<string>;
  // The root id list changed — the stage's direct children need reordering (roots have no parent id, so they get
  // this dedicated flag instead of a synthetic sentinel id in `orderDirtyParents`).
  rootsDirty: boolean;
  // Ids present in the OLD index but absent from `liveIds` (state.nodes) — DERIVED from the index, never trusted
  // from the wire. Each node appears in exactly one old child list (or the old roots), and a removed INTERIOR node
  // was itself an old parent KEY (its own old list is scanned because that key is absent from the new index), so
  // whole removed subtrees are covered without any recursive walk. Unchanged (ref-reused) lists are skipped — an
  // element-equal list cannot contain a removed member, because rebuilt lists only ever contain live ids.
  removedIds: string[];
  // How many ids are present in the NEW index but were absent from the OLD one — the "adds" half of the structural
  // churn metric (removals + reorders alone under-count a delta that only ADDS: a screen that grows 400 fresh nodes
  // dirties few parents and removes nothing). DERIVED from the index, never from the wire's changed-id set.
  //
  // Counted without an O(scene) id set: only the NON-ref-reused old lists can contain an id that resurfaces in a
  // non-ref-reused new list, because a node that moved (or whose siblings moved) necessarily changed its OLD
  // parent's list too — so `oldTouched` (members of the old lists that lost ref-reuse, plus the old roots when the
  // roots moved) is a sound superset of "old ids reachable from a dirty new list". Anything in a dirty new list
  // that is not in it is new to the index. Both halves are bounded by the size of the churn itself.
  addedCount: number;
}

function sameIdList(a: string[], b: string[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// NOTE: MUTATES `newIndex.childIdsByParent` — a parent whose rebuilt list is element-equal to the old one gets the
// OLD array REFERENCE put back, so unchanged lists stay ref-stable across walks (bounding per-delta GC churn to
// what actually changed, and keeping future ref-compares possible).
export function diffStructure(
  oldIndex: StructureIndex,
  newIndex: StructureIndex,
  liveIds: { has(id: string): boolean }
): StructureDiffResult {
  const orderDirtyParents = new Set<string>();
  const removedIds: string[] = [];
  const oldTouched = new Set<string>();
  const oldKids = oldIndex.childIdsByParent;
  const newKids = newIndex.childIdsByParent;

  // Pass 1 — parents present in the NEW index: element-equal lists are ref-reused; anything else is order-dirty
  // (including a parent that gained its FIRST child, whose key is absent from the old index).
  for (const [pid, newList] of newKids) {
    const oldList = oldKids.get(pid);
    if (oldList && sameIdList(oldList, newList)) {
      newKids.set(pid, oldList);
    } else {
      orderDirtyParents.add(pid);
    }
  }

  // Pass 2 — old lists that did NOT survive ref-reuse: they may contain removed members, and a still-alive parent
  // whose key vanished from the new index (lost ALL children) is order-dirty too.
  for (const [pid, oldList] of oldKids) {
    if (newKids.get(pid) === oldList) {
      continue; // ref-reused above → element-equal → every member is live
    }
    if (!newKids.has(pid) && liveIds.has(pid)) {
      orderDirtyParents.add(pid);
    }
    for (const id of oldList) {
      oldTouched.add(id);
      if (!liveIds.has(id)) {
        removedIds.push(id);
      }
    }
  }

  const rootsDirty = !sameIdList(oldIndex.rootIds, newIndex.rootIds);
  if (rootsDirty) {
    for (const id of oldIndex.rootIds) {
      oldTouched.add(id);
      if (!liveIds.has(id)) {
        removedIds.push(id);
      }
    }
  }

  // Pass 3 — the adds. Only a DIRTY list (order-dirty parent, or the roots when they moved) can hold an id the old
  // index never had; every other new list is the old array by reference.
  let addedCount = 0;
  for (const pid of orderDirtyParents) {
    const newList = newKids.get(pid);
    if (!newList) {
      continue; // a parent that LOST all its children has no new list
    }
    for (const id of newList) {
      if (!oldTouched.has(id)) {
        addedCount++;
      }
    }
  }
  if (rootsDirty) {
    for (const id of newIndex.rootIds) {
      if (!oldTouched.has(id)) {
        addedCount++;
      }
    }
  }

  return { orderDirtyParents, rootsDirty, removedIds, addedCount };
}
