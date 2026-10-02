// READABLE-HAND MODE, THE CANVAS BINDING — everything the single-canvas stage has to supply that the DOM stage
// supplies differently, and nothing else.
//
// THE POLICY IS NOT HERE. Which nodes move, by how much, which gates hold the lift down and which hit surfaces
// went with them is `@/mirror/raise/handRaisePlan`, shared with the DOM backend — so the two stages cannot answer
// the same frame differently. This module contributes the two things that ARE this backend's:
//
//   1. THE INDEX. The DOM maintains its five membership sets incrementally during its element walk; a canvas build
//      has no such walk, so it SCANS (`scanRaiseIndex`) and builds a child index per pass (`createChildIndex`).
//      Both are shared helpers — restated walk, shared policy, exactly as `hitTest.ts` restates
//      `computeSceneInfo`'s walk and nothing else.
//   2. THE POSE READ's two live facts. The read itself is shared (`raise/holderLocalY` — same five legs for both
//      backends); what is bound here is the frame the endpoint is measured in and WHICH endpoint counts as live,
//      the H10 port that module's guard explains. Both of that module's questions are bound here off the ONE env:
//      where a holder is HEADED (the ramp's input, `canvasRaiseIndex`) and where it IS (`canvasPaintedLocalY`,
//      the value the lift channel has to leave when a pose ease leaves its own start).
//
// The offsets the plan returns are applied by `canvasRenderer` as COSMETIC OFFSETS (`buildDrawList`'s
// `cosmeticOffsets`): a translate applied to a node and INHERITED by everything under it, drawn-only, invisible to
// `mGame` — the canvas's expression of what the DOM says with a CSS `translate`.

import {
  createChildIndex,
  planHandRaise,
  raiseModeOn,
  scanRaiseIndex,
  EMPTY_HAND_RAISE_PLAN,
  type ChildrenOf,
  type HandRaiseInput,
  type HandRaisePlan,
  type RaiseSceneIndex,
  type RaiseSceneScan
} from "@/mirror/raise/handRaisePlan";
import { holderLocalY, holderPaintedLocalY, type HolderPoseEnv } from "@/mirror/raise/holderLocalY";
import type { MirrorNode, MirrorState } from "@/mirror/sceneTree";

export type { HandRaiseInput, HandRaisePlan };
export {
  anyTargetingArrowVisible,
  createChildIndex,
  // The ramp arithmetic itself, re-exported so the stage that applies the offsets asks it of the pose a holder is
  // drawn at through the same import as everything else in this binding — one spelling, both questions.
  handRaiseDy,
  EMPTY_HAND_RAISE_PLAN
} from "@/mirror/raise/handRaisePlan";

export { creatureHudMeasure, type CreatureHudMeasure } from "@/mirror/raise/creatureHud";

/**
 * The two live animation facts `holderLocalY` cannot read off the scene state, supplied by whoever owns the tween
 * evaluator. OPTIONAL BY DESIGN: absent, the pass takes exactly the legs it took
 * before this existed — see `holderLocalY`, where the endpoint leg is the only addition and it is skipped whole.
 */
export interface HandRaiseTweenEnv {
  /**
   * `tweenLoop.transformEndpointInto` with the frame's clock already bound: the GLOBAL transform the node is
   * headed for, written into `out6`, true when a transform channel is GENUINELY LIVE (see that method — a running
   * channel or an uncollected settle; a card flight answers false).
   */
  transformEndpointInto(nodeId: string, out6: number[]): boolean;
  /**
   * The composed GLOBAL y of a node, BLIND TO OVERRIDES — the streamed composition, the canvas twin of the DOM
   * record's `cParentGlobal`. Blind because it is the frame the endpoint itself was lifted into: an ancestor's own
   * running tween is a separate channel and measuring against it would double-count that ancestor's motion.
   */
  parentGlobalY(nodeId: string): number | null;
}

/**
 * Plan one frame's raise for the canvas stage: scan the state for the membership facts, bind this backend's pose
 * read, and hand both to the shared planner.
 *
 * A pure function of the state plus the two live facts in `HandRaiseInput` — so a caller can run it, diff it
 * against the last one, and repaint only when it changed.
 *
 * `cache`/`verify` are WP4's `rustRaiseIndexCache`/`rustFastVerify` (see the cache block below): `cache` is the
 * CALLER's own {@link RaiseIndexCacheSlot} (or `null` to run uncached), threaded through rather than read off a
 * flags object here so this module stays free of any dependency on `rustFastFlags`.
 * `renderer/canvas/interactionRuntime.ts` is the one caller — it owns one slot per runtime instance and clears it
 * on `dispose()` (see the slot's own doc).
 */
export function planCanvasHandRaise(
  state: MirrorState | null,
  input: HandRaiseInput,
  tween: HandRaiseTweenEnv | null = null,
  cache: RaiseIndexCacheSlot | null = null,
  verify = false
): HandRaisePlan {
  // Asked before the SCAN, not after: with the mode off this backend must not walk the whole state to build an
  // index the planner would throw away. (The shared planner asks the same question again; it is one branch.)
  if (!raiseModeOn(input.enabled)) {
    return EMPTY_HAND_RAISE_PLAN;
  }
  return planHandRaise(canvasRaiseIndex(state, tween, cache, verify), input);
}

/** The scan + the pose read, as the shared planner's index. Exported so a probe can measure what the pass saw. */
export function canvasRaiseIndex(
  state: MirrorState | null,
  tween: HandRaiseTweenEnv | null,
  cache: RaiseIndexCacheSlot | null = null,
  verify = false
): RaiseSceneIndex {
  if (state === null) {
    return EMPTY_INDEX;
  }
  const nodes = state.nodes;
  const scan = cache ? cachedScanRaiseIndex(cache, state, verify) : scanRaiseIndex(nodes);
  // The child index is built ONCE per pass, and lazily: a scene with no creature on screen never pays for it (it
  // is the creature walks, and only they, that need a parent → children map). With the cache on, it is also built
  // at most once per REVISION rather than once per pass — see the cache block below.
  let children: ChildrenOf | null = null;
  // ONE env for the whole pass, not one per holder: this is called for every card in the hand on every frame the
  // plan is re-run, and the two ports it binds are the same two for all of them.
  const pose = canvasPoseEnv(nodes, state, tween);
  return {
    nodes,
    childrenOf: (id) => (children ??= cache ? cachedCreateChildIndex(cache, state, verify) : createChildIndex(state))(id),
    holders: scan.holders,
    handRootId: scan.handRootId,
    handHitboxes: scan.handHitboxes,
    creatureGroups: scan.creatureGroups,
    targeting: scan.targeting,
    choicePrompt: scan.choicePrompt,
    holderLocalY: (id) => holderLocalY(pose, id)
  };
}

// --- WP4: the raise-index cache (`rustRaiseIndexCache`) ----------------------------------------------------------
//
// `scanRaiseIndex` walks every node and `createChildIndex` walks `orderedIds`; both are pure functions of the
// state's own `nodes`/`orderedIds`, which `applySceneDelta` mutates IN PLACE and marks with a bumped `revision` on
// every delta (`sceneTree.ts`). So `(state object, revision)` is an exact cache key for both — the same precedent
// as `interactionRuntime.targetingArrowVisible`. Nothing about WHERE a holder is headed (`holderLocalY`) or this
// client's own drag is cached here: those come from `HandRaiseInput`/`HandRaiseTweenEnv` and `canvasPoseEnv` reads
// them fresh on every call, cache hit or not — see `planHandRaise`'s own `holderLocalY(id)` calls.
//
// Rust-only by construction: a non-null `cache` slot and `verify=true` only ever come from a caller that read them
// off `rustFastFlags.resolveRustFastFlags`'s `rustRaiseIndexCache`/`rustFastVerify`, which it restricts to
// `backend === "rust"` — the Pixi canvas backend always calls `canvasRaiseIndex`/`planCanvasHandRaise` with
// `cache: null` (their default), so this cache never engages for it.

/**
 * Per-RUNTIME storage for the cache above — owned by the caller (one per `createCanvasInteractionRuntime`
 * instance via `createRaiseIndexCacheSlot`), not a module global. A module global would (a) strongly hold the last
 * `MirrorState` it saw — a ~3k-node map — for as long as the PAGE lives, well past the runtime that built it being
 * disposed, and (b) let two live runtimes on different states (an A/B bench, or two mirror instances) evict each
 * other's cache every call instead of each keeping its own. `clearRaiseIndexCacheSlot` is the runtime's `dispose()`
 * calling this off, so neither survives the runtime.
 */
export interface RaiseIndexCacheSlot {
  scanState: MirrorState | null;
  scanRevision: number;
  scan: RaiseSceneScan | null;
  childrenState: MirrorState | null;
  childrenRevision: number;
  childrenOf: ChildrenOf | null;
  /** Shadow-check seam for `rustFastVerify=1`: mismatches between a cached answer and a from-scratch recompute. */
  verifyMismatches: number;
}

export function createRaiseIndexCacheSlot(): RaiseIndexCacheSlot {
  return {
    scanState: null, scanRevision: -1, scan: null,
    childrenState: null, childrenRevision: -1, childrenOf: null,
    verifyMismatches: 0
  };
}

/** Drop everything the slot retains (its `MirrorState` reference included) and zero its counter. */
export function clearRaiseIndexCacheSlot(slot: RaiseIndexCacheSlot): void {
  slot.scanState = null;
  slot.scanRevision = -1;
  slot.scan = null;
  slot.childrenState = null;
  slot.childrenRevision = -1;
  slot.childrenOf = null;
  slot.verifyMismatches = 0;
}

function sameRaiseScan(a: RaiseSceneScan, b: RaiseSceneScan): boolean {
  if (a.handRootId !== b.handRootId || a.targeting !== b.targeting || a.choicePrompt !== b.choicePrompt) {
    return false;
  }
  if (a.holders.size !== b.holders.size) return false;
  for (const id of a.holders) {
    if (!b.holders.has(id)) return false;
  }
  if (a.handHitboxes.size !== b.handHitboxes.size) return false;
  for (const [id, owner] of a.handHitboxes) {
    if (b.handHitboxes.get(id) !== owner) return false;
  }
  if (a.creatureGroups.size !== b.creatureGroups.size) return false;
  for (const [id, root] of a.creatureGroups) {
    if (b.creatureGroups.get(id) !== root) return false;
  }
  return true;
}

// Compares every id `createChildIndex` could possibly have keyed its map on — the union of both sides' PARENT ids,
// not `state.orderedIds` (a node's OWN id, not its parent's; checking that set instead would silently skip any
// parent id that is referenced by a child but is not itself a tracked node, exactly the case a stale/wrong cache
// could disagree on without either side ever being asked about it).
function sameChildIndex(state: MirrorState, a: ChildrenOf, b: ChildrenOf): boolean {
  const parentIds = new Set<string>();
  for (const id of state.orderedIds) {
    const parentId = state.nodes.get(id)?.parentId;
    if (parentId != null) parentIds.add(parentId);
  }
  for (const parentId of parentIds) {
    const ca = a(parentId);
    const cb = b(parentId);
    if (ca.length !== cb.length) return false;
    for (let i = 0; i < ca.length; i++) {
      if (ca[i] !== cb[i]) return false;
    }
  }
  return true;
}

// Under verify, ALWAYS return the freshly recomputed ("trusted") answer, cache hit or not — the same rule
// `interactionRuntime.handPresent`/`coverAbove` follow for `sceneIndexVerify`. A mismatch only increments the
// counter; the cached answer never gets to reach a caller once it has been found (or merely not yet been checked
// to be) wrong.
function cachedScanRaiseIndex(slot: RaiseIndexCacheSlot, state: MirrorState, verify: boolean): RaiseSceneScan {
  const hit = slot.scan !== null && slot.scanState === state && slot.scanRevision === state.revision;
  if (!verify) {
    if (hit) return slot.scan!;
    const scan = scanRaiseIndex(state.nodes);
    slot.scanState = state;
    slot.scanRevision = state.revision;
    slot.scan = scan;
    return scan;
  }
  const trusted = scanRaiseIndex(state.nodes);
  if (hit && !sameRaiseScan(slot.scan!, trusted)) slot.verifyMismatches++;
  slot.scanState = state;
  slot.scanRevision = state.revision;
  slot.scan = trusted;
  return trusted;
}

function cachedCreateChildIndex(slot: RaiseIndexCacheSlot, state: MirrorState, verify: boolean): ChildrenOf {
  const hit = slot.childrenOf !== null && slot.childrenState === state && slot.childrenRevision === state.revision;
  if (!verify) {
    if (hit) return slot.childrenOf!;
    const childrenOf = createChildIndex(state);
    slot.childrenState = state;
    slot.childrenRevision = state.revision;
    slot.childrenOf = childrenOf;
    return childrenOf;
  }
  const trusted = createChildIndex(state);
  if (hit && !sameChildIndex(state, slot.childrenOf!, trusted)) slot.verifyMismatches++;
  slot.childrenState = state;
  slot.childrenRevision = state.revision;
  slot.childrenOf = trusted;
  return trusted;
}

/**
 * WHERE THIS HOLDER IS DRAWN RIGHT NOW, in its container — the SECOND question of the same two ports, asked at the
 * instant a fresh transform ease is about to be armed on it (see `interactionRuntime.noteTransformArmPose`).
 *
 * `canvasRaiseIndex` above asks where a holder is HEADED, because that is the ramp's input. This asks where it IS,
 * because that is the value the cosmetic lift channel has to leave when the pose channel leaves its own start —
 * two channels summed into one drawn position stay together only if they also start together. Null means the pose
 * is unknown on this frame: the shared read refuses the resting-fan guess here (see `holderPaintedLocalY`), and a
 * caller must leave the lift alone rather than step it to a pose the card is not at.
 */
export function canvasPaintedLocalY(
  state: MirrorState | null,
  tween: HandRaiseTweenEnv | null,
  id: string
): number | null {
  return state === null ? null : holderPaintedLocalY(canvasPoseEnv(state.nodes, state, tween), id);
}

/** No state at all (the pre-first-delta pass): an index that answers nothing, so the plan is the empty one. */
const EMPTY_INDEX: RaiseSceneIndex = {
  nodes: new Map<string, MirrorNode>(),
  childrenOf: () => [],
  holders: [],
  handRootId: null,
  handHitboxes: new Map(),
  creatureGroups: new Map(),
  targeting: false,
  choicePrompt: false,
  holderLocalY: () => null
};

/** `transformEndpointInto`'s out-param. Module-scope and reused: the pose read is synchronous and never nests. */
const endpointScratch: number[] = [0, 0, 0, 0, 0, 0];

/**
 * The pose read, as `raise/holderLocalY` wants it: THE LEGS ARE SHARED, this binds the two facts that are this
 * backend's.
 *
 * `liveEndpointY` is the H10 port (see that module's guard). An endpoint may be preferred ONLY while the tween is
 * GENUINELY LIVE, never merely because one was once armed — and that test is not restated here either: it is
 * folded into `tweenLoop.transformEndpointInto`, which answers false for anything but a running channel or an
 * uncollected settle (and false outright for a card flight), because a predicate spread across two modules is a
 * predicate that will disagree with itself. Omitting the evaluator drops that leg whole.
 */
function canvasPoseEnv(
  nodes: ReadonlyMap<string, MirrorNode>,
  _state: MirrorState,
  tween: HandRaiseTweenEnv | null
): HolderPoseEnv {
  return {
    nodes,
    parentGlobalY: (parentId) => (tween == null ? null : tween.parentGlobalY(parentId)),
    liveEndpointY: (id) =>
      tween != null && tween.transformEndpointInto(id, endpointScratch) ? endpointScratch[5] : null
  };
}
