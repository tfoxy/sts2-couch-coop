import { describe, expect, it } from "vitest";
import { createTextResourceEvictionTracker } from "./textResourceEviction";

describe("createTextResourceEvictionTracker", () => {
  it("evicts nothing while the pool has room", () => {
    const tracker = createTextResourceEvictionTracker(2);
    expect(tracker.commit(["a"], ["a"])).toEqual([]);
    expect(tracker.commit(["b"], ["a", "b"])).toEqual([]); // "a" unreferenced, pool has room (1/2)
    expect(tracker.pending).toBe(1);
  });

  it("never evicts a key the latest commit still references", () => {
    const tracker = createTextResourceEvictionTracker(0);
    // A pool limit of zero would evict anything unreferenced immediately, but "a" is referenced every time.
    for (let i = 0; i < 5; i++) expect(tracker.commit(["a"], ["a"])).toEqual([]);
    expect(tracker.pending).toBe(0);
  });

  it("evicts the oldest-unreferenced key first once the pool overflows", () => {
    const tracker = createTextResourceEvictionTracker(2);
    expect(tracker.commit(["b"], ["a", "b"])).toEqual([]); // pool: [a]
    expect(tracker.commit(["c"], ["a", "b", "c"])).toEqual([]); // pool: [a, b]
    expect(tracker.commit(["d"], ["a", "b", "c", "d"])).toEqual(["a"]); // pool: [b, c]
    expect(tracker.pending).toBe(2);
  });

  it("protects a key that toggles back into reference before it ages out of the pool", () => {
    const tracker = createTextResourceEvictionTracker(2);
    tracker.commit(["b"], ["a", "b"]); // pool: [a]
    tracker.commit(["a", "b"], ["a", "b"]); // "a" referenced again, back out of the pool
    expect(tracker.pending).toBe(0);
    // Confirm "a" is no longer a stale candidate: three more unrelated commits should not report it evicted
    // until the pool genuinely overflows with newer keys.
    tracker.commit(["b"], ["a", "b"]); // pool: [a]
    expect(tracker.commit(["c"], ["a", "b", "c"])).toEqual([]); // pool: [a, b] — still room
    expect(tracker.commit(["d"], ["a", "b", "c", "d"])).toEqual(["a"]); // pool: [b, c] — overflow now
  });

  it("evicts exactly the overflow amount in one commit, even when several keys drop out at once", () => {
    const tracker = createTextResourceEvictionTracker(1);
    // "a" and "b" both become unreferenced in the SAME commit, overflowing a pool of 1 by one key.
    expect(tracker.commit(["z"], ["a", "b", "z"])).toEqual(["a"]);
    expect(tracker.pending).toBe(1); // "b" stays pooled; the pool sits at its limit, not below it.
  });

  it("treats cached keys the caller never mentions as references as immediately poolable", () => {
    const tracker = createTextResourceEvictionTracker(1);
    expect(tracker.commit([], ["stale"])).toEqual([]); // pool: [stale], within limit
    expect(tracker.commit([], ["stale", "newer"])).toEqual(["stale"]); // overflow evicts the older one
    expect(tracker.pending).toBe(1);
  });

  it("rejects a negative or non-integer pool limit", () => {
    expect(() => createTextResourceEvictionTracker(0.5)).toThrow();
    expect(() => createTextResourceEvictionTracker(-1)).toThrow();
  });
});
