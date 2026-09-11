import type { MirrorNode } from "@/mirror/sceneTree";
import { mirrorWalkStats } from "@/mirror/renderer/walkStats";
import type { RenderRecord, WalkCtx } from "@/mirror/renderer/dom/recordModel";
const HATCH_BUDGET_MS = 3;
const HATCH_IDLE_MS = 200;
const HATCH_STEP_MS = 0;
const HATCH_REARM_TOLERANCE_MS = 50;
const REVEAL_STAGGER_MIN_NODES = 400;
const REVEAL_STAGGER_FIRST_NODES = 400;
const REVEAL_STAGGER_BATCH_NODES = 400;
const REVEAL_STAGGER_FALLBACK_MS = 250;

export interface DormancyLifecycle {
  readonly hatchBudgetMs: number;
  readonly hatchIdleMs: number;
  setDormant(record: RenderRecord, on: boolean, queue?: boolean): void;
  isHatching(): boolean;
  canBuildDormant(id: string): boolean;
  markerCount(): number;
  isRevealHeld(id: string): boolean;
  forgetReveal(id: string): void;
  hasRevealHolds(): boolean;
  stageReveal(rootId: string): void;
  flushReveal(): void;
  drainRevealForTest(budgetNodes?: number): number;
  scheduleHatch(delayMs: number): void;
  drainHatchForTest(budgetMs?: number): boolean;
  dispose(): void;
}

export interface DormancyLifecycleOptions {
  records: Map<string, RenderRecord>;
  getNodes: () => Map<string, MirrorNode>;
  getChildIds: (id: string) => readonly string[] | undefined;
  getLastOrderedIds: () => string[] | null;
  now: () => number;
  visit: (id: string, ctx: WalkCtx, structural: boolean) => void;
  beginHatchSlice: (started: number, dirty: Set<string>) => void;
  finishHatchSlice: () => void;
}

// State and scheduling for the renderer's three deferred-paint mechanisms. DOM/record ownership stays in the
// reconciler: this runtime only owns marker membership, queues and lifecycle ordering.
export function createDormancyLifecycle(options: DormancyLifecycleOptions): DormancyLifecycle {
  const dormantPending = new Set<string>();
  let dormantMarkers = 0;
  let hatchTimer: ReturnType<typeof setTimeout> | null = null;
  let hatchTimerAt = Infinity;
  let hatching = false;
  let hatchDeadline = 0;
  let hatchEntryId: string | null = null;
  const hatchDirty = new Set<string>();
  const hatchOrder: string[] = [];
  let hatchOrderIndex: Map<string, number> | null = null;
  let hatchOrderIndexFor: string[] | null = null;

  const revealHeldIds = new Set<string>();
  const revealQueue: string[] = [];
  const revealHoldSizes = new Map<string, number>();
  let revealReleaseRaf = 0;
  let revealReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  function setDormant(record: RenderRecord, on: boolean, queue = true): void {
    if (record.dormant === on) {
      if (on && !queue) dormantPending.delete(record.id);
      return;
    }
    record.dormant = on;
    dormantMarkers += on ? 1 : -1;
    if (on && queue) dormantPending.add(record.id);
    else dormantPending.delete(record.id);
  }

  function scheduleHatch(delayMs: number): void {
    if (dormantPending.size === 0 || typeof setTimeout !== "function") {
      if (hatchTimer !== null) clearTimeout(hatchTimer);
      hatchTimer = null;
      hatchTimerAt = Infinity;
      return;
    }
    const due = options.now() + delayMs;
    if (hatchTimer !== null && Math.abs(due - hatchTimerAt) <= HATCH_REARM_TOLERANCE_MS) return;
    if (hatchTimer !== null) clearTimeout(hatchTimer);
    hatchTimerAt = due;
    hatchTimer = setTimeout(() => {
      hatchTimer = null;
      hatchTimerAt = Infinity;
      drainHatch(HATCH_BUDGET_MS);
      scheduleHatch(HATCH_STEP_MS);
    }, delayMs);
  }

  function orderedPending(): string[] {
    hatchOrder.length = 0;
    for (const id of dormantPending) hatchOrder.push(id);
    const lastOrderedIds = options.getLastOrderedIds();
    if (hatchOrder.length > 1 && lastOrderedIds !== null) {
      if (hatchOrderIndexFor !== lastOrderedIds) {
        hatchOrderIndex = new Map<string, number>();
        for (let i = 0; i < lastOrderedIds.length; i++) hatchOrderIndex.set(lastOrderedIds[i], i);
        hatchOrderIndexFor = lastOrderedIds;
      }
      const index = hatchOrderIndex!;
      hatchOrder.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    }
    return hatchOrder;
  }

  function drainHatch(budgetMs: number): boolean {
    if (dormantPending.size === 0) return false;
    const started = options.now();
    mirrorWalkStats.hatchDrains++;
    hatchDeadline = started + budgetMs;
    hatching = true;
    options.beginHatchSlice(started, hatchDirty);
    try {
      for (const id of orderedPending()) {
        const record = options.records.get(id);
        if (!record || !record.dormant) {
          dormantPending.delete(id);
          continue;
        }
        const node = options.getNodes().get(id);
        const ctx = record.lastCtxRef;
        if (node == null || ctx == null || !record.haveCtx || !ctx.domParent.isConnected) {
          dormantPending.delete(id);
          continue;
        }
        dormantPending.delete(id);
        hatchEntryId = id;
        hatchDirty.clear();
        hatchDirty.add(id);
        options.visit(id, ctx, false);
        if (options.now() >= hatchDeadline) break;
      }
    } finally {
      hatching = false;
      hatchEntryId = null;
      hatchDirty.clear();
      hatchOrder.length = 0;
      options.finishHatchSlice();
      mirrorWalkStats.dormantRoots = dormantMarkers;
      mirrorWalkStats.hatchMs += options.now() - started;
    }
    return dormantPending.size > 0;
  }

  function collectSubtreeSizes(rootId: string, out: Map<string, number>): number {
    const stack = [rootId];
    const order: string[] = [];
    while (stack.length) {
      const id = stack.pop()!;
      order.push(id);
      const kids = options.getChildIds(id);
      if (kids) for (const kid of kids) stack.push(kid);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      let size = 1;
      const kids = options.getChildIds(id);
      if (kids) for (const kid of kids) size += out.get(kid) ?? 1;
      out.set(id, size);
    }
    return out.get(rootId) ?? 1;
  }

  function scheduleRevealRelease(): void {
    if (revealReleaseRaf !== 0 || revealReleaseTimer !== null || revealQueue.length === 0) return;
    const fire = (): void => {
      if (revealReleaseRaf !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(revealReleaseRaf);
      revealReleaseRaf = 0;
      if (revealReleaseTimer !== null) clearTimeout(revealReleaseTimer);
      revealReleaseTimer = null;
      releaseRevealBatch(REVEAL_STAGGER_BATCH_NODES);
    };
    if (typeof requestAnimationFrame === "function") revealReleaseRaf = requestAnimationFrame(fire);
    if (typeof setTimeout === "function") revealReleaseTimer = setTimeout(fire, REVEAL_STAGGER_FALLBACK_MS);
  }

  function releaseRevealBatch(budgetNodes: number): void {
    let spent = 0;
    while (revealQueue.length > 0 && spent < budgetNodes) {
      const id = revealQueue.shift()!;
      if (!revealHeldIds.delete(id)) continue;
      spent += revealHoldSizes.get(id) ?? 1;
      revealHoldSizes.delete(id);
      const record = options.records.get(id);
      if (record?.el && !record.paintSuppressed) record.el.style.display = "";
    }
    mirrorWalkStats.revealStaggerBatches++;
    if (revealQueue.length > 0) scheduleRevealRelease();
    else revealHoldSizes.clear();
  }

  function stageReveal(rootId: string): void {
    if (typeof requestAnimationFrame !== "function" && typeof setTimeout !== "function") return;
    const sizes = new Map<string, number>();
    if (collectSubtreeSizes(rootId, sizes) < REVEAL_STAGGER_MIN_NODES) return;
    let budget = REVEAL_STAGGER_FIRST_NODES;
    const held: string[] = [];
    const partition = (parentId: string): void => {
      const kids = options.getChildIds(parentId);
      if (!kids) return;
      for (const kid of kids) {
        const size = sizes.get(kid) ?? 1;
        if (budget >= size) {
          budget -= size;
          continue;
        }
        const grandKids = options.getChildIds(kid);
        if (budget > 0 && grandKids !== undefined && grandKids.length > 0) {
          budget--;
          partition(kid);
        } else held.push(kid);
      }
    };
    partition(rootId);
    if (held.length === 0) return;
    for (const id of held) {
      if (revealHeldIds.has(id)) continue;
      revealHeldIds.add(id);
      revealQueue.push(id);
      const size = sizes.get(id) ?? 1;
      revealHoldSizes.set(id, size);
      mirrorWalkStats.revealStaggerHeldNodes += size;
    }
    mirrorWalkStats.revealStaggerHolds += held.length;
    scheduleRevealRelease();
  }

  function flushReveal(): void {
    if (revealReleaseRaf !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(revealReleaseRaf);
    revealReleaseRaf = 0;
    if (revealReleaseTimer !== null) clearTimeout(revealReleaseTimer);
    revealReleaseTimer = null;
    if (revealQueue.length === 0 && revealHeldIds.size === 0) return;
    releaseRevealBatch(Number.POSITIVE_INFINITY);
    revealHeldIds.clear();
    revealQueue.length = 0;
    revealHoldSizes.clear();
  }

  function dispose(): void {
    if (hatchTimer !== null) clearTimeout(hatchTimer);
    hatchTimer = null;
    hatchTimerAt = Infinity;
    dormantPending.clear();
    flushReveal();
    hatchOrder.length = 0;
    hatchOrderIndex = null;
    hatchOrderIndexFor = null;
  }

  return {
    hatchBudgetMs: HATCH_BUDGET_MS,
    hatchIdleMs: HATCH_IDLE_MS,
    setDormant,
    isHatching: () => hatching,
    canBuildDormant: (id) => hatching && (id === hatchEntryId || options.now() < hatchDeadline),
    markerCount: () => dormantMarkers,
    isRevealHeld: (id) => revealHeldIds.has(id),
    forgetReveal: (id) => {
      revealHeldIds.delete(id);
    },
    hasRevealHolds: () => revealQueue.length > 0 || revealHeldIds.size > 0,
    stageReveal,
    flushReveal,
    drainRevealForTest: (budgetNodes = REVEAL_STAGGER_BATCH_NODES) => {
      releaseRevealBatch(budgetNodes);
      return revealQueue.length;
    },
    scheduleHatch,
    drainHatchForTest: (budgetMs = HATCH_BUDGET_MS) => drainHatch(budgetMs),
    dispose
  };
}
