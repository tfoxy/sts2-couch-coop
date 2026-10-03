/**
 * rustTextEvict: decide which Bitmap text resource keys to release once a scene actually commits.
 *
 * A key that drops out of the committed scene is not released immediately — a short-lived label that toggles
 * in and out of view across a few commits (e.g. a hint that blinks) would otherwise pay for a re-rasterization
 * every time it reappears. Instead it sits in a bounded, recently-unreferenced pool; only a key that ages out of
 * that pool (because enough OTHER keys became unreferenced after it) is actually evicted.
 *
 * This module is a pure decision — it has no knowledge of the Bitmap cache, the Rust executor, or the wire
 * format. The caller (`createRustDrawListExecutor.ts`) is the one that knows what "referenced" and "cached"
 * mean, and the one that performs the actual release.
 */
export interface TextResourceEvictionTracker {
  /**
   * Call once per committed full build, and per committed `rustTextPatch` patch that changed the resource list.
   * `referenced` is every Bitmap resource key the just-committed scene uses; `cached` is
   * every key currently in the Bitmap JS cache. Returns the keys to evict right now, in the order they should be
   * released (oldest-unreferenced first).
   */
  commit(referenced: Iterable<string>, cached: Iterable<string>): string[];
  /** Diagnostic-only: the current recently-unreferenced pool size. */
  readonly pending: number;
}

export function createTextResourceEvictionTracker(poolLimit: number): TextResourceEvictionTracker {
  if (!Number.isInteger(poolLimit) || poolLimit < 0) throw new Error("poolLimit must be a non-negative integer");
  // Map insertion order doubles as the LRU order: the key that became unreferenced longest ago is first.
  const unreferenced = new Map<string, true>();
  return {
    commit(referenced, cached) {
      const referencedSet = referenced instanceof Set ? referenced : new Set(referenced);
      // A key back in use is never a candidate, no matter how long it sat in the pool.
      for (const key of referencedSet) unreferenced.delete(key);
      for (const key of cached) if (!referencedSet.has(key) && !unreferenced.has(key)) unreferenced.set(key, true);
      const overflow = unreferenced.size - poolLimit;
      if (overflow <= 0) return [];
      const evicted: string[] = [];
      for (const key of unreferenced.keys()) {
        if (evicted.length >= overflow) break;
        evicted.push(key);
      }
      for (const key of evicted) unreferenced.delete(key);
      return evicted;
    },
    get pending() { return unreferenced.size; },
  };
}
