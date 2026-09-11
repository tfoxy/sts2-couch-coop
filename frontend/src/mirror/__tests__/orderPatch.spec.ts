import { describe, expect, it } from "vitest";

import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// Stage 4 (client side): applySceneDelta reconstructs orderedIds from a compact order patch. It rebuilds the
// structure from the PREVIOUS orderedIds + node map (the exact rebuildStructure rules), applies the dirty
// parents/roots, and pre-order flattens. This spec pins the deterministic shapes AND fuzzes patch-apply against a
// directly-built order over random tree mutations (the same diff the server computes).

function wireNode(id: string, parentId: string | null): Record<string, unknown> {
  return { id, parentId, name: id, nodeType: "Control" };
}

function full(state: MirrorState, order: string[], parents: Record<string, string | null>): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: order.map((id) => wireNode(id, parents[id] ?? null)),
      orderedIds: order
    })!
  );
}

function patchDelta(
  state: MirrorState,
  parts: {
    upserts?: Record<string, unknown>[];
    removedIds?: string[];
    orderPatch: { roots?: string[] | null; parents: { p: string; c: string[] }[] };
  }
): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: parts.upserts ?? [],
      removedIds: parts.removedIds ?? [],
      orderPatch: parts.orderPatch
    })!
  );
}

describe("order patch apply (Stage 4)", () => {
  it("reorders a parent's children", () => {
    const state = createMirrorState();
    full(state, ["R", "a", "b", "c"], { R: null, a: "R", b: "R", c: "R" });
    patchDelta(state, { orderPatch: { parents: [{ p: "R", c: ["c", "a", "b"] }] } });
    expect(state.orderedIds).toEqual(["R", "c", "a", "b"]);
  });

  it("inserts a new child (with its own subtree) via upsert + patch", () => {
    const state = createMirrorState();
    full(state, ["R", "a", "b"], { R: null, a: "R", b: "R" });
    patchDelta(state, {
      upserts: [wireNode("x", "R"), wireNode("x1", "x")],
      orderPatch: { parents: [{ p: "R", c: ["a", "x", "b"] }, { p: "x", c: ["x1"] }] }
    });
    expect(state.orderedIds).toEqual(["R", "a", "x", "x1", "b"]);
  });

  it("removes a child (parent cleared / trimmed)", () => {
    const state = createMirrorState();
    full(state, ["R", "a", "b", "c"], { R: null, a: "R", b: "R", c: "R" });
    patchDelta(state, { removedIds: ["b"], orderPatch: { parents: [{ p: "R", c: ["a", "c"] }] } });
    expect(state.orderedIds).toEqual(["R", "a", "c"]);
  });

  it("reparents a node (old parent cleared, new parent gains it)", () => {
    const state = createMirrorState();
    full(state, ["R", "P1", "x", "P2"], { R: null, P1: "R", x: "P1", P2: "R" });
    patchDelta(state, {
      upserts: [wireNode("x", "P2")], // parentId changes to P2
      orderPatch: { parents: [{ p: "P1", c: [] }, { p: "P2", c: ["x"] }] }
    });
    expect(state.orderedIds).toEqual(["R", "P1", "P2", "x"]);
  });

  it("applies a roots reorder", () => {
    const state = createMirrorState();
    full(state, ["A", "B"], { A: null, B: null });
    patchDelta(state, { orderPatch: { roots: ["B", "A"], parents: [] } });
    expect(state.orderedIds).toEqual(["B", "A"]);
  });

  it("produces a NEW orderedIds array reference (so the renderer re-derives)", () => {
    const state = createMirrorState();
    full(state, ["R", "a", "b"], { R: null, a: "R", b: "R" });
    const before = state.orderedIds;
    patchDelta(state, { orderPatch: { parents: [{ p: "R", c: ["b", "a"] }] } });
    expect(state.orderedIds).not.toBe(before);
  });
});

// ---- randomized cross-check: patch-apply == directly-built order over random mutations -----------------------

type Tree = { nodes: Map<string, string | null>; order: string[] };

function buildStructure(order: string[], nodes: Map<string, string | null>): { rootIds: string[]; childIdsByParent: Map<string, string[]> } {
  const childIdsByParent = new Map<string, string[]>();
  const rootIds: string[] = [];
  for (const id of order) {
    if (!nodes.has(id)) continue;
    const parentId = nodes.get(id) ?? null;
    if (parentId != null && nodes.has(parentId)) {
      const list = childIdsByParent.get(parentId) ?? [];
      if (list.length === 0) childIdsByParent.set(parentId, list);
      list.push(id);
    } else {
      rootIds.push(id);
    }
  }
  return { rootIds, childIdsByParent };
}

function flatten(rootIds: string[], childIdsByParent: Map<string, string[]>): string[] {
  const out: string[] = [];
  const stack = [...rootIds].reverse();
  while (stack.length) {
    const id = stack.pop() as string;
    out.push(id);
    const kids = childIdsByParent.get(id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// The server's diff (BuildPatch): dirty parents + roots, using BOTH orders indexed against the CURRENT node map.
function serverDiff(
  oldOrder: string[],
  newOrder: string[],
  nodes: Map<string, string | null>
): { roots: string[] | null; parents: { p: string; c: string[] }[] } {
  const oldIdx = buildStructure(oldOrder, nodes);
  const newIdx = buildStructure(newOrder, nodes);
  const dirty = new Set<string>();
  for (const [p, list] of newIdx.childIdsByParent) {
    const old = oldIdx.childIdsByParent.get(p);
    if (!old || !sameList(old, list)) dirty.add(p);
  }
  for (const [p] of oldIdx.childIdsByParent) {
    if (!newIdx.childIdsByParent.has(p)) dirty.add(p);
  }
  const rootsDirty = !sameList(oldIdx.rootIds, newIdx.rootIds);
  const parents = [...dirty].map((p) => ({ p, c: newIdx.childIdsByParent.get(p) ?? [] }));
  return { roots: rootsDirty ? newIdx.rootIds : null, parents };
}

// Deterministic PRNG (mulberry32) so a failure reproduces.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTree(rand: () => number, size: number): Tree {
  const nodes = new Map<string, string | null>();
  const ids: string[] = ["n0"];
  nodes.set("n0", null);
  for (let i = 1; i < size; i++) {
    const id = `n${i}`;
    const parent = ids[Math.floor(rand() * ids.length)];
    nodes.set(id, parent);
    ids.push(id);
  }
  const { rootIds, childIdsByParent } = buildStructure(ids, nodes);
  return { nodes, order: flatten(rootIds, childIdsByParent) };
}

function mutate(rand: () => number, tree: Tree, nextId: { v: number }): Tree {
  const nodes = new Map(tree.nodes);
  const ids = [...nodes.keys()];
  const op = Math.floor(rand() * 4);
  if (op === 0) {
    // add a node under a random parent
    const id = `m${nextId.v++}`;
    nodes.set(id, ids[Math.floor(rand() * ids.length)]);
  } else if (op === 1 && ids.length > 1) {
    // remove a random non-root LEAF (no children) to keep the tree simple
    const leaves = ids.filter((id) => nodes.get(id) != null && ![...nodes.values()].includes(id));
    if (leaves.length) nodes.delete(leaves[Math.floor(rand() * leaves.length)]);
  } else if (op === 2 && ids.length > 2) {
    // reparent a random node to a non-descendant (avoid cycles): pick a node, move under n0 or another root-ish
    const movable = ids.filter((id) => nodes.get(id) != null);
    if (movable.length) {
      const node = movable[Math.floor(rand() * movable.length)];
      // choose a new parent that is NOT the node or a descendant of it
      const descendants = new Set<string>([node]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [c, p] of nodes) {
          if (p != null && descendants.has(p) && !descendants.has(c)) {
            descendants.add(c);
            grew = true;
          }
        }
      }
      const candidates = ids.filter((id) => !descendants.has(id));
      if (candidates.length) nodes.set(node, candidates[Math.floor(rand() * candidates.length)]);
    }
  }
  // recompute the canonical order (pre-order DFS)
  const { rootIds, childIdsByParent } = buildStructure([...nodes.keys()], nodes);
  return { nodes, order: flatten(rootIds, childIdsByParent) };
}

describe("order patch randomized cross-check", () => {
  it("patch-apply equals the directly-built order across random mutations", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      let tree = randomTree(rand, 10 + Math.floor(rand() * 20));
      const nextId = { v: 0 };

      const state = createMirrorState();
      const parents: Record<string, string | null> = {};
      for (const [id, p] of tree.nodes) parents[id] = p;
      full(state, tree.order, parents);

      for (let step = 0; step < 12; step++) {
        const prevOrder = tree.order;
        const next = mutate(rand, tree, nextId);
        // Build the wire delta the server would send: upsert every current node (carries latest parentId), remove
        // vanished ids, and the order patch computed against the NEW node map (as the server does).
        const removedIds = [...tree.nodes.keys()].filter((id) => !next.nodes.has(id));
        const upserts = [...next.nodes].map(([id, p]) => wireNode(id, p));
        const orderPatch = serverDiff(prevOrder, next.order, next.nodes);
        patchDelta(state, { upserts, removedIds, orderPatch });
        expect(state.orderedIds, `seed ${seed} step ${step}`).toEqual(next.order);
        tree = next;
      }
    }
  });
});
