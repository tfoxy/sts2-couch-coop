// WP4 (`rustRaiseIndexCache`): `canvasRaiseIndex` caches `scanRaiseIndex`/`createChildIndex` per `(state object,
// revision)` instead of rebuilding them from scratch on every hand-raise pass (see the cache block in
// `canvas/handRaise.ts`). These specs exercise the cache directly, at the unit the flag actually gates, rather than
// through a full renderer — `handRaise.spec.ts` already covers the DOM-backed policy end to end.
import { describe, expect, it } from "vitest";

import {
  canvasRaiseIndex,
  createRaiseIndexCacheSlot,
  type RaiseIndexCacheSlot
} from "@/mirror/canvas/handRaise";
import type { ChildrenOf } from "@/mirror/raise/handRaisePlan";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 16 } },
    visible: true,
    ...over
  };
}

// A minimal combat hand, same shape as `handRaise.spec.ts`'s `handScene`: a container, one holder, its hitbox.
function handNodes(): Record<string, unknown>[] {
  return [
    node("PlayerHand", null, { nodeType: "NPlayerHand" }),
    node("CardHolderContainer", "PlayerHand"),
    node("h0", "CardHolderContainer", { nodeType: "NHandCardHolder" }),
    node("h0Hitbox", "h0", { name: "Hitbox", mouseFilter: 0 }),
    node("h0Card", "h0", { nodeType: "NCard", name: "Card" })
  ];
}

function freshState(nodes: Record<string, unknown>[]): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
  return state;
}

// Bumps `state.revision` the way a real volatile delta does, without otherwise touching membership.
function touch(state: MirrorState, id: string): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      screenType: "run",
      upserts: [{ id, parentId: state.nodes.get(id)!.parentId, localRect: { position: { x: 1, y: 1 }, size: { x: 100, y: 16 } } }]
    })!
  );
}

describe("canvasRaiseIndex — the rustRaiseIndexCache cache", () => {
  it("hits on the same state object and revision: the scan's own Sets/Maps are the identical instance", () => {
    const slot = createRaiseIndexCacheSlot();
    const state = freshState(handNodes());

    const first = canvasRaiseIndex(state, null, slot, false);
    const second = canvasRaiseIndex(state, null, slot, false);

    expect(second.holders).toBe(first.holders);
    expect(second.handHitboxes).toBe(first.handHitboxes);
    expect(second.creatureGroups).toBe(first.creatureGroups);
    // The child index is cached too: the SAME array instance comes back for the same parent id.
    expect(second.childrenOf("CardHolderContainer")).toBe(first.childrenOf("CardHolderContainer"));
  });

  it("misses once the state's revision bumps, even on the same object", () => {
    const slot = createRaiseIndexCacheSlot();
    const state = freshState(handNodes());

    // `childrenOf` is lazy — read it from EACH pass before the next delta lands, or its own closure resolves
    // against whatever revision is current when it is finally called rather than the one it was planned for.
    const first = canvasRaiseIndex(state, null, slot, false);
    const firstChildren = first.childrenOf("CardHolderContainer");
    touch(state, "h0");
    const second = canvasRaiseIndex(state, null, slot, false);
    const secondChildren = second.childrenOf("CardHolderContainer");

    expect(second.holders).not.toBe(first.holders);
    expect(secondChildren).not.toBe(firstChildren);
    // The recompute still answers the same facts — only the cache identity changed, not the content.
    expect([...second.holders]).toEqual([...first.holders]);
  });

  it("misses on a different state object, even at the same revision number", () => {
    const slot = createRaiseIndexCacheSlot();
    const stateA = freshState(handNodes());
    const stateB = freshState(handNodes());
    expect(stateB.revision).toBe(stateA.revision);

    const first = canvasRaiseIndex(stateA, null, slot, false);
    const second = canvasRaiseIndex(stateB, null, slot, false);

    expect(second.holders).not.toBe(first.holders);
  });

  it("never rebuilds when the cache is off (no slot): every call gets its own Set/Map instance", () => {
    const state = freshState(handNodes());

    const first = canvasRaiseIndex(state, null, null, false);
    const second = canvasRaiseIndex(state, null, null, false);

    expect(second.holders).not.toBe(first.holders);
  });

  // Fix (code review): the cache used to be a MODULE GLOBAL, so two runtimes on different states would evict each
  // other's entry on every call. Each runtime now owns its own slot (`createRaiseIndexCacheSlot`), so two slots
  // over the very same state never interfere with each other at all.
  it("keeps two independent slots over the SAME state from interfering with each other", () => {
    const slotA = createRaiseIndexCacheSlot();
    const slotB = createRaiseIndexCacheSlot();
    const state = freshState(handNodes());

    const a1 = canvasRaiseIndex(state, null, slotA, false);
    const b1 = canvasRaiseIndex(state, null, slotB, false);
    // Different slots never share a cached instance, even for the same state/revision…
    expect(b1.holders).not.toBe(a1.holders);
    // …but each slot is internally consistent across repeated calls, same as the single-slot case above.
    const a2 = canvasRaiseIndex(state, null, slotA, false);
    expect(a2.holders).toBe(a1.holders);
  });

  it("keeps the verify mismatch counter at 0 across cache hits, misses, and a revision bump", () => {
    const slot = createRaiseIndexCacheSlot();
    const state = freshState(handNodes());

    const first = canvasRaiseIndex(state, null, slot, true); // scan: miss (cold cache)
    first.childrenOf("CardHolderContainer"); // children: miss (cold cache, not compared)
    const second = canvasRaiseIndex(state, null, slot, true); // scan: hit, shadow-checked against a fresh scan
    second.childrenOf("CardHolderContainer"); // children: hit, shadow-checked against a fresh child index
    touch(state, "h0");
    const third = canvasRaiseIndex(state, null, slot, true); // scan: miss again after the bump
    third.childrenOf("CardHolderContainer"); // children: miss again after the bump

    expect(slot.verifyMismatches).toBe(0);
  });

  // Fix (code review): under verify, a mismatch used to be COUNTED but the cached (possibly stale) answer was
  // still what the caller got back. Now the freshly recomputed ("trusted") answer is what verify always returns —
  // provable here because a verified cache hit never reuses the cached Set instance, unlike a non-verified hit.
  it("under verify, always returns a freshly recomputed answer rather than the cached instance", () => {
    const slot = createRaiseIndexCacheSlot();
    const state = freshState(handNodes());

    const first = canvasRaiseIndex(state, null, slot, true);
    const second = canvasRaiseIndex(state, null, slot, true); // would be a hit, but verify is on

    expect(second.holders).not.toBe(first.holders); // a fresh recompute, not the cached Set
    expect([...second.holders]).toEqual([...first.holders]); // same content — only the identity differs
    expect(slot.verifyMismatches).toBe(0); // and it genuinely matched, so nothing was miscounted either
  });

  // Fix (code review): `sameChildIndex` used to walk only `state.orderedIds` (node ids), not the actual keys
  // `createChildIndex` can produce (PARENT ids, which include a dangling `parentId` nobody tracks as a node). A
  // cached answer that disagreed ONLY at such a key would have gone uncaught.
  it("verify catches a child-index mismatch at a parent id that is not itself a tracked node", () => {
    const slot = createRaiseIndexCacheSlot();
    const state = freshState([...handNodes(), node("orphanChild", "GhostParent")]);

    // Seed the slot with a "cached" answer that is wrong ONLY at the untracked parent id "GhostParent" — every id
    // in `state.orderedIds` (i.e. every actual node) still agrees with a fresh recompute.
    const wrong: ChildrenOf = (id) => (id === "GhostParent" ? [] : realChildrenOf(state)(id));
    const seeded: RaiseIndexCacheSlot = { ...slot, childrenState: state, childrenRevision: state.revision, childrenOf: wrong };

    canvasRaiseIndex(state, null, seeded, true).childrenOf("GhostParent");

    expect(seeded.verifyMismatches).toBe(1);
  });
});

// A real child index, used only to build the "wrong" stand-in above (agreeing everywhere except the one id under
// test) — re-derived via the public `canvasRaiseIndex` so the test has no private import of `createChildIndex`.
function realChildrenOf(state: MirrorState): ChildrenOf {
  return canvasRaiseIndex(state, null, null, false).childrenOf;
}
