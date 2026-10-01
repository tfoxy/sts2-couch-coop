// EXACT CANDIDATE INDEX (`rustSceneIndex`) — a cheap, incrementally-maintained SUPERSET of which node ids could
// satisfy a caller's predicate, so a per-frame query can skip straight to the ids worth checking instead of
// scanning every node. "Candidate" is the operative word: membership is a HINT, never ground truth — a caller
// MUST re-verify every candidate against the current node before trusting it, exactly as it would have checked
// that node in a full scan. That is what keeps the index exact even though its bookkeeping is approximate about
// WHEN to reclassify a node that changed only because something else did (see `invalidateAll` below).
//
// THE CONTRACT, deliberately the same one `PaintOrderCache.noteChanged` already uses (canvas/paintOrder.ts): call
// `noteChanged(nodes, changedIds)` once per reconcile, right after `invalidateAll()` on a `state.sceneRewrite`.
// `changedIds` is the reconciler's own accumulated upsert/removal set, so an id this index has never seen notified
// is an id whose classification cannot have moved — the only way to learn otherwise is the full rebuild a dirty
// index (fresh, or since the last `invalidateAll`) does on its next `noteChanged`.
//
// ONE NODE, ONE CLASSIFICATION: `classify` reads a node's OWN fields only (type, a style flag — never an ancestor
// or sibling), because an id only ever re-enters `changedIds` when ITS OWN upsert/removal arrives. A predicate
// that also depends on an ancestor (the static-background skip-root rule, for one) cannot be indexed this way; see
// the per-node `WeakMap` memo `createPixiMirrorRenderer.ts` uses for that case instead.

import type { MirrorNode } from "@/mirror/sceneTree";

/** `classify(node)` names every bucket `node` belongs to today (usually zero or one). */
export type SceneCandidateClassifier = (node: MirrorNode) => readonly string[];

export interface SceneCandidateIndex {
  /** Node ids classified into `bucket` as of the last `noteChanged`. A caller must still verify each one. */
  idsIn(bucket: string): ReadonlySet<string>;
  /** Drop every classification; the next `noteChanged` does one full O(scene) rebuild instead of an incremental one. */
  invalidateAll(): void;
  /** Fold the reconciler's `changedIds` in — see the contract above. */
  noteChanged(nodes: ReadonlyMap<string, MirrorNode>, changedIds: Iterable<string>): void;
}

const EMPTY_BUCKET: ReadonlySet<string> = new Set();

export function createSceneCandidateIndex(classify: SceneCandidateClassifier): SceneCandidateIndex {
  const buckets = new Map<string, Set<string>>();
  // The buckets an id was last filed under, so a reclassification (or a removal) knows what to retract.
  const lastBucketsOf = new Map<string, readonly string[]>();
  let dirty = true;

  const bucketFor = (name: string): Set<string> => {
    let set = buckets.get(name);
    if (!set) {
      set = new Set();
      buckets.set(name, set);
    }
    return set;
  };

  const classifyInto = (id: string, node: MirrorNode | undefined): void => {
    const previous = lastBucketsOf.get(id);
    if (previous !== undefined) {
      for (const name of previous) buckets.get(name)?.delete(id);
    }
    if (node === undefined) {
      lastBucketsOf.delete(id);
      return;
    }
    const next = classify(node);
    if (next.length === 0) {
      lastBucketsOf.delete(id);
      return;
    }
    lastBucketsOf.set(id, next);
    for (const name of next) bucketFor(name).add(id);
  };

  return {
    idsIn(bucket) {
      return buckets.get(bucket) ?? EMPTY_BUCKET;
    },
    invalidateAll() {
      dirty = true;
    },
    noteChanged(nodes, changedIds) {
      if (dirty) {
        buckets.clear();
        lastBucketsOf.clear();
        for (const node of nodes.values()) classifyInto(node.id, node);
        dirty = false;
        return;
      }
      for (const id of changedIds) classifyInto(id, nodes.get(id));
    },
  };
}
