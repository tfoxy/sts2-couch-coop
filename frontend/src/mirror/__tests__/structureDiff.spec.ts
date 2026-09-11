import { describe, expect, it } from "vitest";

import { diffStructure, type StructureIndex } from "@/mirror/structureDiff";

// Build an index from a plain object ({parent: [children]}) + roots. Fresh arrays every call, like rebuildStructure.
function index(kids: Record<string, string[]>, roots: string[]): StructureIndex {
  const childIdsByParent = new Map<string, string[]>();
  for (const [pid, list] of Object.entries(kids)) {
    childIdsByParent.set(pid, [...list]);
  }
  return { childIdsByParent, rootIds: [...roots] };
}

function live(...ids: string[]): { has(id: string): boolean } {
  return new Set(ids);
}

describe("diffStructure", () => {
  it("returns an empty diff for identical indices and ref-reuses every unchanged list", () => {
    const oldIdx = index({ r: ["a", "b"], a: ["c"] }, ["r"]);
    const newIdx = index({ r: ["a", "b"], a: ["c"] }, ["r"]);
    const oldRList = oldIdx.childIdsByParent.get("r")!;
    const oldAList = oldIdx.childIdsByParent.get("a")!;

    const diff = diffStructure(oldIdx, newIdx, live("r", "a", "b", "c"));

    expect(diff.orderDirtyParents.size).toBe(0);
    expect(diff.rootsDirty).toBe(false);
    expect(diff.removedIds).toEqual([]);
    // Equal lists were replaced by the OLD array references (GC + future ref-compares).
    expect(newIdx.childIdsByParent.get("r")).toBe(oldRList);
    expect(newIdx.childIdsByParent.get("a")).toBe(oldAList);
  });

  it("flags only the permuted parent on a sibling reorder; other lists stay ref-reused", () => {
    const oldIdx = index({ r: ["a", "b", "c"], a: ["x", "y"] }, ["r"]);
    const newIdx = index({ r: ["c", "a", "b"], a: ["x", "y"] }, ["r"]);
    const oldAList = oldIdx.childIdsByParent.get("a")!;

    const diff = diffStructure(oldIdx, newIdx, live("r", "a", "b", "c", "x", "y"));

    expect([...diff.orderDirtyParents]).toEqual(["r"]);
    expect(diff.removedIds).toEqual([]);
    expect(diff.rootsDirty).toBe(false);
    expect(newIdx.childIdsByParent.get("a")).toBe(oldAList);
  });

  it("flags a parent that gained a child (including its FIRST child, absent from the old index)", () => {
    const oldIdx = index({ r: ["a"] }, ["r"]);
    const newIdx = index({ r: ["a", "b"], a: ["k"] }, ["r"]); // b added under r; a gained its first child k
    const diff = diffStructure(oldIdx, newIdx, live("r", "a", "b", "k"));
    expect(diff.orderDirtyParents).toEqual(new Set(["r", "a"]));
    expect(diff.removedIds).toEqual([]);
  });

  it("derives removals from liveness, never the wire: removed child → parent dirty + child in removedIds", () => {
    const oldIdx = index({ r: ["a", "b"] }, ["r"]);
    const newIdx = index({ r: ["a"] }, ["r"]);
    const diff = diffStructure(oldIdx, newIdx, live("r", "a")); // b no longer live
    expect(diff.orderDirtyParents).toEqual(new Set(["r"]));
    expect(diff.removedIds).toEqual(["b"]);
  });

  it("covers a whole removed SUBTREE: each removed interior node was itself an old parent key", () => {
    // r → p → (c1, c2); c1 → g. Remove the whole p subtree.
    const oldIdx = index({ r: ["p", "s"], p: ["c1", "c2"], c1: ["g"] }, ["r"]);
    const newIdx = index({ r: ["s"] }, ["r"]);
    const diff = diffStructure(oldIdx, newIdx, live("r", "s"));
    expect(diff.orderDirtyParents).toEqual(new Set(["r"])); // p/c1 are NOT dirty parents — they're gone
    expect(new Set(diff.removedIds)).toEqual(new Set(["p", "c1", "c2", "g"]));
    expect(diff.removedIds.length).toBe(4); // each removed node reported exactly once
  });

  it("flags a still-alive parent that lost ALL its children (key vanished from the new index)", () => {
    const oldIdx = index({ r: ["p"], p: ["c"] }, ["r"]);
    const newIdx = index({ r: ["p"] }, ["r"]); // p alive, childless
    const diff = diffStructure(oldIdx, newIdx, live("r", "p"));
    expect(diff.orderDirtyParents).toEqual(new Set(["p"]));
    expect(diff.removedIds).toEqual(["c"]);
  });

  it("marks BOTH parents dirty on a reparent and does not report the moved node as removed", () => {
    const oldIdx = index({ r: ["a", "b"], a: ["m"], b: [] }, ["r"]);
    const newIdx = index({ r: ["a", "b"], b: ["m"] }, ["r"]); // m moved a → b (a now childless)
    const diff = diffStructure(oldIdx, newIdx, live("r", "a", "b", "m"));
    expect(diff.orderDirtyParents).toEqual(new Set(["a", "b"]));
    expect(diff.removedIds).toEqual([]);
  });

  it("reports permuted/removed ROOTS via rootsDirty and derives root removals", () => {
    const oldIdx = index({}, ["a", "b", "c"]);
    const permuted = diffStructure(oldIdx, index({}, ["c", "a", "b"]), live("a", "b", "c"));
    expect(permuted.rootsDirty).toBe(true);
    expect(permuted.removedIds).toEqual([]);

    const removed = diffStructure(index({}, ["a", "b", "c"]), index({}, ["a", "c"]), live("a", "c"));
    expect(removed.rootsDirty).toBe(true);
    expect(removed.removedIds).toEqual(["b"]);
  });
});

// addedCount — the "adds" half of the renderer's structural-churn metric. Derived from the index (ids in the new
// one that the old one never had), NOT from the wire's changed-id set.
describe("diffStructure addedCount", () => {
  it("is 0 when nothing was added (identical, reorder, removal, reparent)", () => {
    expect(diffStructure(index({ r: ["a"] }, ["r"]), index({ r: ["a"] }, ["r"]), live("r", "a")).addedCount).toBe(0);
    expect(
      diffStructure(index({ r: ["a", "b"] }, ["r"]), index({ r: ["b", "a"] }, ["r"]), live("r", "a", "b")).addedCount
    ).toBe(0);
    expect(
      diffStructure(index({ r: ["a", "b"] }, ["r"]), index({ r: ["a"] }, ["r"]), live("r", "a")).addedCount
    ).toBe(0);
    // Reparent: `m` moved a → b. It is not new to the index, so it must not count as an add.
    expect(
      diffStructure(
        index({ r: ["a", "b"], a: ["m"] }, ["r"]),
        index({ r: ["a", "b"], b: ["m"] }, ["r"]),
        live("r", "a", "b", "m")
      ).addedCount
    ).toBe(0);
  });

  it("counts fresh children, a whole added subtree, and added roots", () => {
    // Two new children under r, plus a new subtree n → (n1, n2) hanging off one of them.
    const diff = diffStructure(
      index({ r: ["a"] }, ["r"]),
      index({ r: ["a", "b", "n"], n: ["n1", "n2"] }, ["r"]),
      live("r", "a", "b", "n", "n1", "n2")
    );
    expect(diff.addedCount).toBe(4); // b, n, n1, n2

    const roots = diffStructure(index({}, ["a"]), index({}, ["a", "z"]), live("a", "z"));
    expect(roots.rootsDirty).toBe(true);
    expect(roots.addedCount).toBe(1);
  });

  it("counts an add and a removal independently in the same diff (the pooled-card swap)", () => {
    const diff = diffStructure(
      index({ hand: ["a"], a: ["a1"] }, ["hand"]),
      index({ hand: ["b"], b: ["b1"] }, ["hand"]),
      live("hand", "b", "b1")
    );
    expect(new Set(diff.removedIds)).toEqual(new Set(["a", "a1"]));
    expect(diff.addedCount).toBe(2);
  });
});
