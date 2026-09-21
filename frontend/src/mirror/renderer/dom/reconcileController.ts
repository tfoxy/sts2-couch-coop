import { IDENTITY_AFFINE } from "@/mirror/affine";
import type { LandingLog, LandingProbe } from "@/mirror/landingLog";
import {
  MIRROR_DESIGN_WIDTH,
  type MirrorNode,
  type MirrorState,
} from "@/mirror/sceneTree";
import type { FullWalkCause } from "@/mirror/renderer/contracts";
import {
  diffStructure,
  type StructureDiffResult,
  type StructureIndex,
} from "@/mirror/structureDiff";
import {
  BAIL_MIN_ORDER_CHURN,
  BAIL_ORDER_CHURN_RATIO,
  IDENTITY_RGB,
  type WalkMode,
} from "./walkModel";
import type { RenderRecord, WalkCtx } from "./recordModel";
import type { NodeWalker } from "./nodeWalker";
import type { NodeController } from "./nodeController";
import type { DormancyLifecycle } from "./dormancyLifecycle";
import type { ElementLifecycle } from "./elementLifecycle";
import type { CardFlightController } from "./cardFlightController";
import type { TweenController } from "./tweenController";
import type { HandController } from "./handController";
import type { ScaleController } from "./scaleController";
import type { OcclusionRuntime } from "./occlusionRuntime";
import type { SpineGeoclipTimeline } from "./spineGeoclipTimeline";
import type { StaticBackgroundRuntime } from "./staticBackgroundRuntime";
import type { AnimationRuntime } from "./animationRuntime";
import type { MirrorWalkStats } from "@/mirror/renderer/walkStats";

type SvgDefs = { syncHsvDefs(): void };

export interface ReconcileControllerPorts {
  stage: HTMLElement;
  records: Map<string, RenderRecord>;
  nodeWalker(): NodeWalker;
  nodeController: NodeController;
  elementLifecycle: ElementLifecycle;
  dormancy: DormancyLifecycle;
  cardFlights: CardFlightController;
  tweens: TweenController;
  handController: HandController<RenderRecord>;
  scaleController: ScaleController;
  occlusionRuntime: OcclusionRuntime;
  spineTimeline: SpineGeoclipTimeline;
  staticBgRuntime: StaticBackgroundRuntime;
  beginSceneAblationWalk(nodes: ReadonlyMap<string, MirrorNode>, rootIds: readonly string[]): void;
  sceneAblationChangedIds(): readonly string[];
  animationRuntime: AnimationRuntime;
  svgDefs: SvgDefs;
  landingLog: LandingLog;
  landingProbe: LandingProbe;
  now(): number;
  scheduleTick(): void;
  markEffectsDirty(): void;
  resetShaderDocCache(): void;
  removeEl(record: RenderRecord): void;
  removeTargeting(id: string): void;
  forgetHandRecord(id: string): void;
  sampleBlendCensus(nodes: ReadonlyMap<string, MirrorNode>): void;
  stats: MirrorWalkStats;
}

export interface ReconcileController {
  readonly nodes: () => Map<string, MirrorNode>;
  readonly childIdsByParent: () => Map<string, string[]>;
  readonly rootIds: () => string[];
  readonly orderedIds: () => string[];
  readonly lastOrderedIds: () => string[] | null;
  readonly orphanRootIds: () => ReadonlySet<string> | null;
  readonly subtreeDirty: () => Set<string> | null;
  readonly textureDirtySelf: () => Set<string> | null;
  readonly changedParents: () => ReadonlySet<string>;
  readonly orderDirtyParents: () => ReadonlySet<string>;
  readonly visited: () => Set<string> | null;
  readonly walkNow: () => number;
  readonly spreadFactor: () => number;
  readonly geometryEpoch: () => number;
  readonly geometryDirty: () => boolean;
  markGeomDirty(): void;
  markGeomRebase(id: string): void;
  noteRevealBuilt(): void;
  reconcile(
    state: MirrorState,
    options?: { forceTextures?: boolean; reason?: FullWalkCause },
  ): void;
  markTextureDirty(ids: Iterable<string>): void;
  setStretch(factor: number): void;
  beginDormancyHatch(started: number, dirty: Set<string>): void;
  finishDormancyHatch(): void;
  beginDispose(): void;
  finishDispose(): void;
}

/**
 * Stateful reconciliation coordinator. It owns the replaceable scene indexes and all walk-scoped scratch; node
 * traversal remains in NodeWalker and DOM mechanics remain in their respective controllers. Getter ports are
 * intentional: structural walks replace maps, so collaborators must never retain an old tree.
 */
export function createReconcileController(
  p: ReconcileControllerPorts,
): ReconcileController {
  let nodes = new Map<string, MirrorNode>();
  let childIdsByParent = new Map<string, string[]>();
  let rootIds: string[] = [];
  let orphanRootIds: Set<string> | null = null;
  let lastOrderedIds: string[] | null = null;
  let walkOrderedIds: string[] = [];
  let firstBuild = true;
  let spreadFactor = 1;
  let geometryEpoch = 1;
  let geomDirty = false;
  let inWalk = false;
  let visited: Set<string> | null = null;
  let revealBuiltThisWalk = false;
  let subtreeDirty: Set<string> | null = null;
  const pendingTextureDirty = new Set<string>();
  /**
   * Subtrees that must be RE-BASED on the next walk because a transform pin over them has ended.
   *
   * While an ancestor is transform-tween pinned the walk skips its descendants wholesale (nodeWalker's
   * `skipForPin`) and they keep the parent global they last cached. When the pin ends nothing offers them a
   * context again, and if the node's own stream then goes quiet the walk skips the ancestor too
   * (`lastNode === node`, ctx unchanged, not in `subtreeDirty`) — so the descendants keep a pose from the middle
   * of the animation for as long as the scene stays still.
   *
   * That is not cosmetic: `interactiveRects()` composes each hit box out of its record's cached parent global,
   * so the stale ones are the boxes the mirror hit-tests against. Measured live on the touch fixture — one hover
   * in ten left a hand card's hit box 140-160 design px above the card that the game's own poses, the DOM and
   * the rendered frame all agreed was at rest, and it never recovered; every pointer resolved through it missed
   * the card. `markGeomDirty()` cannot fix this on its own: it invalidates the caches that key on the epoch,
   * while the walk's skip gate is independent of it.
   *
   * This is the geometry twin of the PIN PAINT REPAIR in nodeWalker, which fixes exactly the same "and then
   * nothing dirties this subtree again" hazard for inherited tint.
   */
  const pendingGeomRebase = new Set<string>();
  let textureDirtySelf: Set<string> | null = null;
  const changedParents = new Set<string>();
  const orderDirtyParents = new Set<string>();
  let rootsOrderDirty = false;
  let fixupNeeded = false;
  let walkNow = 0;

  // Geometry consumers cache against this epoch. During one synchronous walk a structural change can invalidate
  // every downstream cache, so one bump is enough; between walks every mutation is independently observable and
  // must advance the epoch.
  function markGeomDirty(): void {
    if (inWalk) {
      if (geomDirty) return;
      geomDirty = true;
    }
    geometryEpoch++;
    p.stats.geomEpoch = geometryEpoch;
  }

  function rebuildStructure(state: MirrorState): void {
    // Rebuild only at structural boundaries. `orderedIds` remains producer paint order; an orphan stays in that
    // order as a root but is marked separately so traversal holds it invisible instead of inventing a new tree.
    childIdsByParent = new Map();
    rootIds = [];
    orphanRootIds = null;
    for (const id of state.orderedIds) {
      const node = state.nodes.get(id);
      if (!node) continue;
      if (node.parentId != null && state.nodes.has(node.parentId)) {
        let children = childIdsByParent.get(node.parentId);
        if (!children) childIdsByParent.set(node.parentId, (children = []));
        children.push(id);
      } else {
        rootIds.push(id);
        if (node.parentId != null) (orphanRootIds ??= new Set()).add(id);
      }
    }
  }

  function markDirty(state: MirrorState): Set<string> {
    // Pruned updates reach each changed leaf and its ancestors. Direct parents are tracked separately because a
    // child's presence/behind status changes the parent's own layer-order slot even when the parent is clean.
    const dirty = new Set<string>();
    changedParents.clear();
    for (const id of state.changedIds) {
      const changed = state.nodes.get(id);
      if (changed?.parentId != null) changedParents.add(changed.parentId);
      if (!changed) markGeomDirty();
      let current: string | null = id;
      while (current != null && !dirty.has(current)) {
        dirty.add(current);
        current = state.nodes.get(current)?.parentId ?? null;
      }
    }
    for (const id of pendingTextureDirty) {
      if (!state.nodes.has(id)) continue;
      (textureDirtySelf ??= new Set()).add(id);
      p.stats.textureRestyles++;
      let current: string | null = id;
      while (current != null && !dirty.has(current)) {
        dirty.add(current);
        current = state.nodes.get(current)?.parentId ?? null;
      }
    }
    // A released pin only needs its OWN node walked: once the walk visits it, the fresh context it hands down
    // fails its children's `ctxUnchanged` compare wherever they really are stale, and they re-base themselves.
    for (const id of pendingGeomRebase) {
      if (!state.nodes.has(id)) continue;
      let current: string | null = id;
      while (current != null && !dirty.has(current)) {
        dirty.add(current);
        current = state.nodes.get(current)?.parentId ?? null;
      }
    }
    for (const id of p.sceneAblationChangedIds()) {
      let current: string | null = id;
      while (current != null && !dirty.has(current)) {
        dirty.add(current);
        current = state.nodes.get(current)?.parentId ?? null;
      }
    }
    return dirty;
  }

  function doWalk(
    state: MirrorState,
    initialMode: WalkMode,
    cause: FullWalkCause | null,
  ): void {
    // `structural` below means FULL, not merely "has an order diff". Incremental structural walks deliberately
    // use update-shaped traversal, then repair only dirty parents.
    let mode = initialMode;
    let fullCause: FullWalkCause = cause ?? "forceTextures";
    textureDirtySelf = null;
    walkNow = p.now();
    p.staticBgRuntime.beginWalk();
    inWalk = true;
    geomDirty = false;
    nodes = state.nodes;
    walkOrderedIds = state.orderedIds;
    if (state.sceneRewrite) p.landingLog.clear();
    p.occlusionRuntime.beginWalk();

    // Keyframes always go full. Normal structural deltas diff old/new indexes and only fall back when measured
    // churn makes pruning more expensive than rebuilding canonical order.
    let diff: StructureDiffResult | null = null;
    if (mode === "incremental") {
      const sceneSize = state.orderedIds.length;
      const preBail = lastOrderedIds === null || state.sceneRewrite;
      if (preBail) {
        p.stats.bails++;
        mode = "full";
        fullCause =
          lastOrderedIds === null
            ? "firstBuild"
            : state.sceneRewrite
              ? "keyframe"
              : "bail";
        rebuildStructure(state);
      } else {
        const oldIndex: StructureIndex = { childIdsByParent, rootIds };
        rebuildStructure(state);
        diff = diffStructure(
          oldIndex,
          { childIdsByParent, rootIds },
          state.nodes,
        );
        const churn =
          diff.orderDirtyParents.size +
          diff.removedIds.length +
          diff.addedCount;
        if (
          churn >
          Math.max(BAIL_MIN_ORDER_CHURN, sceneSize * BAIL_ORDER_CHURN_RATIO)
        ) {
          p.stats.bails++;
          mode = "full";
          fullCause = "bail";
          diff = null;
        }
      }
    } else if (mode === "full" || childIdsByParent.size === 0) {
      rebuildStructure(state);
    }
    p.beginSceneAblationWalk(state.nodes, rootIds);
    if (mode !== "full" && p.sceneAblationChangedIds().length > 0) {
      // A reparent can move an already-built subtree across an ablation boundary without changing the node object.
      // A full ownership sweep releases every descendant record/effect below the newly held root in this same walk.
      mode = "full";
      fullCause = "ablation";
      diff = null;
    }

    p.stats.walks++;
    if (mode === "full") {
      p.stats.fullWalks++;
      p.stats.fullWalkCauses[fullCause]++;
    } else if (mode === "incremental") p.stats.incrementalStructuralWalks++;
    else p.stats.updateWalks++;
    if (mode !== "update") {
      markGeomDirty();
      p.markEffectsDirty();
      p.spineTimeline.noteDomShapeChanged();
    }

    // Full rebuilds invalidate held reveal DOM, cached shader documents and potentially adoptable records. The
    // condemnation sweep remains after visit: records leave active lookup up front, but only die after every
    // potential new id has had a chance to adopt them.
    const structural = mode === "full";
    if (structural && p.dormancy.hasRevealHolds()) p.dormancy.flushReveal();
    rootsOrderDirty = false;
    p.nodeController.clearPendingReorders();
    orderDirtyParents.clear();
    if (structural) {
      p.nodeController.beginFullOrder();
      visited = new Set();
      subtreeDirty = null;
      for (const record of p.records.values()) {
        record.hideLatchedUntil = 0;
        record.hideLatchHeldAt = 0;
        record.hideLatchStreamedOpacity = null;
      }
      p.resetShaderDocCache();
      if (p.elementLifecycle.recordsByAdoptKey.size > 0) {
        for (const [id, record] of p.records) {
          if (!state.nodes.has(id) && p.elementLifecycle.condemnRecord(record))
            p.records.delete(id);
        }
      }
    } else {
      if (diff) {
        // Derived removals are authoritative rather than wire changedIds. A child that survives under a new parent
        // is rescued by visit's changed DOM parent; no special reparent path belongs in removal handling.
        for (const id of diff.removedIds) {
          const record = p.records.get(id);
          if (record) {
            p.records.delete(id);
            if (!p.elementLifecycle.condemnRecord(record)) {
              p.elementLifecycle.dropAdoptKey(record);
              p.removeEl(record);
              p.stats.removedRecords++;
            }
          }
          p.removeTargeting(id);
          p.forgetHandRecord(id);
        }
        for (const parentId of diff.orderDirtyParents)
          orderDirtyParents.add(parentId);
        rootsOrderDirty = diff.rootsDirty;
      }
      subtreeDirty = markDirty(state);
      for (const parentId of orderDirtyParents) {
        let current: string | null = parentId;
        while (current != null && !subtreeDirty.has(current)) {
          subtreeDirty.add(current);
          current = state.nodes.get(current)?.parentId ?? null;
        }
      }
    }
    fixupNeeded = false;
    const rootCtx: WalkCtx = {
      domParent: p.stage,
      tint: IDENTITY_RGB,
      parentInv: null,
      parentGlobal: IDENTITY_AFFINE,
      parentDx: 0,
      deltaParentWidth:
        spreadFactor === 1 ? 0 : (spreadFactor - 1) * MIRROR_DESIGN_WIDTH,
      anchorDelta:
        spreadFactor === 1 ? 0 : (spreadFactor - 1) * MIRROR_DESIGN_WIDTH,
      parentDxProp: false,
      rideDx: 0,
      parentWidth: MIRROR_DESIGN_WIDTH,
      pinnedAncestor: false,
      containerChildAlign: null,
      containerChildVertical: false,
      inCardRewardScreen: false,
      contentScope: null,
      ancestorHidden: false,
    };
    for (const id of rootIds) p.nodeWalker().visit(id, rootCtx, structural);
    // Sweep before ordering, so neither full nor targeted reorders ever see a detached condemned element.
    p.elementLifecycle.sweepCondemned();
    if (structural) {
      // Every unvisited record is either absent from the wire or below a reclaimed dormancy root; both must release
      // retained DOM ownership before the authoritative full order is committed.
      for (const [id, record] of p.records) {
        if (visited!.has(id)) continue;
        p.elementLifecycle.dropAdoptKey(record);
        p.removeEl(record);
        p.records.delete(id);
        p.removeTargeting(id);
        p.forgetHandRecord(id);
        p.stats.removedRecords++;
      }
      p.nodeController.reconcileFullOrder();
      p.nodeController.clearFullOrder();
      visited = null;
    } else {
      // A pruned walk has one reachability hole: a live record reparented into a dormant boundary that visit no
      // longer descends into. Retire its element and retain only a dormant marker until that boundary opens.
      if (p.dormancy.markerCount() > 0) {
        for (const id of state.changedIds) {
          const record = p.records.get(id);
          const node = state.nodes.get(id);
          if (!record || !record.el || node == null || record.lastNode === node)
            continue;
          p.removeEl(record);
          record.haveCtx = false;
          p.dormancy.setDormant(record, true);
          p.stats.dormantSkippedBuilds++;
        }
      }
      // Targeted order is synchronous because own sublayers use behind-child count as an insertion slot. Any
      // unmappable element requests a full fixup rather than guessing an order.
      if (
        p.nodeController.reorderChangedParents({
          rootsOrderDirty,
          orderDirtyParents,
        }).fixupNeeded
      )
        fixupNeeded = true;
      if (fixupNeeded) {
        p.stats.fixupWalks++;
        doWalk(state, "full", "fixup");
        return;
      }
    }
    p.stats.dormantRoots = p.dormancy.markerCount();
    p.staticBgRuntime.finishWalk();
    p.stats.staticBgHeldRoots = p.staticBgRuntime.heldIds.size;
    subtreeDirty = null;
    firstBuild = false;
    lastOrderedIds = state.orderedIds;
    // This ordering is observable: hints establish base transforms; hand raise precedes transform-reading scale
    // passes; occlusion is last because it owns the final display gate. Keep these post-walk passes in this order.
    p.tweens.applyHints(state);
    p.handController.applyHandRaise();
    p.cardFlights.apply(state.pendingCardFlights);
    p.scaleController.applyViewScale();
    p.scaleController.applyTipScale();
    p.occlusionRuntime.apply();
    p.spineTimeline.applyPromotionPass();
    p.stats.spinePromotedNodes = p.spineTimeline.promotedCount;
    state.changedIds.clear();
    pendingTextureDirty.clear();
    pendingGeomRebase.clear();
    textureDirtySelf = null;
    state.sceneRewrite = false;
    p.svgDefs.syncHsvDefs();
    p.animationRuntime.flushPhaseAnchors();
    p.landingLog.tick(p.now(), p.landingProbe);
    inWalk = false;
    geomDirty = false;
  }

  function reconcile(
    state: MirrorState,
    options: { forceTextures?: boolean; reason?: FullWalkCause } = {},
  ): void {
    const full = firstBuild || options.forceTextures === true;
    const orderChanged = state.orderedIds !== lastOrderedIds;
    const mode: WalkMode = full
      ? "full"
      : orderChanged ? "incremental" : "update";
    const cause: FullWalkCause | null = full
      ? firstBuild
        ? "firstBuild"
        : (options.reason ?? "forceTextures")
      : null;
    const started = p.now();
    p.cardFlights.drainDirty(pendingTextureDirty);
    revealBuiltThisWalk = false;
    doWalk(state, mode, cause);
    p.scheduleTick();
    const duration = p.now() - started;
    p.stats.lastWalkMs = duration;
    p.stats.totalWalkMs += duration;
    if (revealBuiltThisWalk) p.stats.revealBuildMs += duration;
    p.sampleBlendCensus(nodes);
    p.dormancy.scheduleHatch(p.dormancy.hatchIdleMs);
  }

  return {
    nodes: () => nodes,
    childIdsByParent: () => childIdsByParent,
    rootIds: () => rootIds,
    orderedIds: () => walkOrderedIds,
    lastOrderedIds: () => lastOrderedIds,
    orphanRootIds: () => orphanRootIds,
    subtreeDirty: () => subtreeDirty,
    textureDirtySelf: () => textureDirtySelf,
    changedParents: () => changedParents,
    orderDirtyParents: () => orderDirtyParents,
    visited: () => visited,
    walkNow: () => walkNow,
    spreadFactor: () => spreadFactor,
    geometryEpoch: () => geometryEpoch,
    geometryDirty: () => geomDirty,
    markGeomDirty,
    /** Re-base this record's subtree on the next walk — see `pendingGeomRebase`. */
    markGeomRebase(id: string) {
      pendingGeomRebase.add(id);
    },
    noteRevealBuilt() {
      revealBuiltThisWalk = true;
    },
    reconcile,
    markTextureDirty(ids) {
      for (const id of ids) {
        pendingTextureDirty.add(id);
        p.stats.textureDirtyIds++;
      }
    },
    setStretch(factor) {
      spreadFactor = Number.isFinite(factor) && factor >= 1 ? factor : 1;
    },
    beginDormancyHatch(started, dirty) {
      walkNow = started;
      subtreeDirty = dirty;
      inWalk = true;
      geomDirty = false;
      rootsOrderDirty = false;
      p.nodeController.clearPendingReorders();
      orderDirtyParents.clear();
      fixupNeeded = false;
    },
    finishDormancyHatch() {
      subtreeDirty = null;
      if (
        p.nodeController.reorderChangedParents({
          rootsOrderDirty,
          orderDirtyParents,
        }).fixupNeeded
      )
        fixupNeeded = true;
      p.animationRuntime.flushPhaseAnchors();
      p.spineTimeline.applyPromotionPass();
      p.stats.spinePromotedNodes = p.spineTimeline.promotedCount;
      inWalk = false;
      geomDirty = false;
      if (fixupNeeded) {
        fixupNeeded = false;
        firstBuild = true;
      }
    },
    beginDispose() {
      changedParents.clear();
      orderDirtyParents.clear();
      p.nodeController.clearPendingReorders();
      inWalk = true;
      geomDirty = false;
    },
    // The record sweep owns the final geometry bump. Its original bracket closes before `records.clear()` so later
    // disposal callbacks cannot mistake teardown for a still-active reconcile window.
    finishDispose() {
      inWalk = false;
    },
  };
}
