/**
 * Canvas interaction runtime.
 *
 * Canvas has no DOM records to query.  This runtime owns the client-only
 * offset channels and answers input from the one drawn-frame snapshot.  The
 * live retained state is used only while preparing the next picture; public
 * queries never combine it with a prior draw list after strict admission
 * declines that picture.
 */

import type { Affine } from "@/mirror/affine";
import { IDENTITY_AFFINE } from "@/mirror/affine";
import type { ConfirmTapKind } from "@/mirror/confirmTap";
import type { EagerScrollTarget } from "@/mirror/eagerScroll";
import {
  buildEagerScrollTargets,
  scanEagerScrollIds,
  type EagerScrollCandidate,
  type EagerScrollLayoutEnv,
} from "@/mirror/eagerScrollLayout";
import type { HandPoseReport, HandPoseSample } from "@/mirror/handPoseProbe";
import { MAP_POINT_SCENE_FILE_SUFFIX } from "@/mirror/mapNodeTap";
import {
  CREATURE_POWER_ROW_H,
  HAND_CHOICE_NAMES,
  HAND_CHOICE_TYPES,
  HAND_CONTAINER_NAME,
  HAND_HOLDER_TYPE,
  HAND_RAISE_PX,
} from "@/mirror/raise/constants";
import { decideHeldLift, heldLiftPx } from "@/mirror/raise/heldLift";
import {
  pointInPlacedRect,
  pointWithinPlacedRectMargin,
  type RaisedHandVisualClaim,
  type RaiseInputStamp,
} from "@/mirror/raiseInverse";
import {
  CARD_TOUCH_TARGET_TYPES,
  DRAWING_TOOL_ARMED_TEXTURES,
  PROCEED_BUTTON_SCENE_FILE_SUFFIX,
  confirmTapEligible,
  hasEffectivelyVisibleDeckCardSelectScreen,
  hasEffectivelyVisibleCardGridSelection,
} from "@/mirror/renderer/interactionPolicy";
import {
  hasAncestorSceneFile,
  hasEchoAncestor,
  hasVisibleDirectChild,
  isHandCard as isSharedHandCard,
} from "@/mirror/renderer/treeQueries";
import type {
  ConfirmTapHit,
  HandRaiseUiLayer,
  InteractiveRect,
  SpreadPainter,
  TouchStack,
} from "@/mirror/renderer/contracts";
import { composeCoverAlpha } from "@/mirror/renderer/coverAlpha";
import {
  MIRROR_DESIGN_HEIGHT,
  MIRROR_DESIGN_WIDTH,
  nodeTypeLeaf,
  type MirrorNode,
  type MirrorRect,
  type MirrorState,
} from "@/mirror/sceneTree";
import {
  VIEW_SCALE_NOMINAL_CARD_H,
  VIEW_SCALE_NOMINAL_CARD_W,
  buildViewScaleInputRegistry,
  type ViewScaleRegistryEnv,
} from "@/mirror/viewScaleLayout";
import type { ViewScaleInputStamp } from "@/mirror/viewScaleInverse";
import {
  anyTargetingArrowVisible,
  creatureHudMeasure,
  planCanvasHandRaise,
  EMPTY_HAND_RAISE_PLAN,
  type CreatureHudMeasure,
  type HandRaisePlan,
  type HandRaiseTweenEnv,
} from "@/mirror/canvas/handRaise";
import {
  createOffsetRamps,
  RAISE_LIFT_RAMP,
  type OffsetRampSample,
  type OffsetRampTiming,
} from "@/mirror/canvas/offsetRamp";
import { hitStack } from "@/mirror/canvas/hitTest";
import type { CosmeticOffset } from "@/mirror/canvas/buildDrawList";
import type { TweenLoop } from "@/mirror/canvas/tweenLoop";

import type { DrawnSceneSnapshot } from "./frameRuntime";

const END_TURN_SCENE_FILE_SUFFIX = "end_turn_button.tscn";
const BACKSTOP_COVER_MIN_ALPHA = 0.7;
const COVER_EDGE_EPS = 1;
const COVER_CHAIN_BUDGET = 64;
const EMPTY_ORDERED_IDS: readonly string[] = Object.freeze([]);
const EMPTY_VIEW_SCALE_STAMPS: ViewScaleInputStamp[] = [];
const EMPTY_NODES: ReadonlyMap<string, MirrorNode> = new Map();
const EMPTY_OFFSETS: ReadonlyMap<string, CosmeticOffset> = new Map();
const EMPTY_NUMBER_MAP: ReadonlyMap<string, number> = new Map();
const EMPTY_IDS: ReadonlySet<string> = new Set();

export interface CanvasInteractionRuntimePorts {
  /** Retained state while preparing a prospective frame. Never use for a public painted query. */
  readonly state: () => MirrorState | null;
  /** The only public-frame authority. */
  readonly snapshot: () => DrawnSceneSnapshot | null;
  readonly now: () => number;
  readonly disposed: () => boolean;
  readonly stage: HTMLElement;
  readonly stageScale: () => number;
  readonly designWidth: () => number;
  readonly spreadFactor: () => number;
  readonly spreadDxByNode: ReadonlyMap<string, number>;
  readonly spreadFieldModeByNode: ReadonlyMap<string, number>;
  readonly loop: () => TweenLoop;
  /** Streamed/global composition for build-time hand and eager-scroll planning. */
  readonly streamedGlobalInto: (state: MirrorState | null, id: string, out: number[]) => boolean;
  /** Immediate canvas presentation for client-only offset changes. */
  readonly rebuildAndPaint: () => void;
  /** The scheduler owns the ordinary animation lane; this only asks it to re-evaluate demand. */
  readonly armAnimation: () => void;
  readonly builds: () => number;
  readonly paintedFrames: () => number;
}

export interface CanvasInteractionRuntime {
  readonly cosmeticOffsets: ReadonlyMap<string, CosmeticOffset>;
  readonly handHolderIds: ReadonlySet<string>;
  readonly cosmeticVersion: number;
  readonly cosmeticVersionAtBuild: number;
  readonly offsetPending: boolean;
  readonly offsetRampDeadline: number;
  readonly offsetBuilds: number;
  readonly offsetCoalesced: number;
  readonly rampFrames: number;

  /** Build-time state only. Called before candidate construction can publish. */
  prepareBuild(): void;
  /** Bind build-derived interaction values to the exact successful frame. */
  publishBuild(snapshot: DrawnSceneSnapshot): void;
  /** A patch retains build products; carry their exact interaction sidecar forward. */
  publishPatch(previous: DrawnSceneSnapshot | null, snapshot: DrawnSceneSnapshot): void;
  invalidateInputCaches(): void;
  collectCaptureIds(out: Set<string>): void;

  noteNodePresent(node: MirrorNode): void;
  noteNodeRemoved(id: string): void;
  noteRewrite(): void;

  applyHeldLift(): void;
  applyHandRaisePass(at?: number): boolean;
  advanceOffsetRamps(at: number): boolean;

  setHeldCard(id: string | null, gameY: number, mode?: "drag" | "peek"): void;
  setRaiseHandCards(enabled: boolean): void;

  raiseInputStamps(): RaiseInputStamp[];
  raisedHandVisualClaimAt(clientX: number, clientY: number): RaisedHandVisualClaim | null;
  raisedHandTouchTargetClaim(touchTargetId: string): RaisedHandVisualClaim | null;
  handPresent(): boolean;
  handRaiseUiLayer(): HandRaiseUiLayer;
  handPoses(): HandPoseReport;
  raiseProbe(): Record<string, unknown>;
  raiseDebug(): {
    readonly enabled: boolean;
    readonly liftPx: number;
    readonly maxLiftPx: number;
    readonly gates: HandRaisePlan["gates"];
    readonly offsets: number;
    readonly movedRects: number;
    readonly stamps: number;
  };

  isCardTouchTarget(id: string): boolean;
  isHandCard(id: string): boolean;
  confirmTapTarget(id: string): ConfirmTapKind | null;
  confirmTapAt(gameX: number, gameY: number): { id: string; kind: ConfirmTapKind } | null;
  coverAbove(id: string): boolean;
  handChoiceActive(): boolean;
  mapDrawingToolActive(): boolean;
  interactiveRects(): InteractiveRect[];
  viewScaleInputStamps(): ViewScaleInputStamp[];
  endTurnBoxAt(gameX: number, gameY: number): { minX: number; minY: number; maxX: number; maxY: number } | null;
  eagerScrollTargets(): EagerScrollTarget[];
  isUnderNode(id: string, ancestorId: string): boolean;
  touchStackAt(clientX: number, clientY: number): TouchStack;
  spreadPainterAt(clientX: number, clientY: number, backdropWidthPx: number): SpreadPainter | null | undefined;
  mapNodeAt(clientX: number, clientY: number): string | null;
  applyLocalOffset(nodeId: string, dy: number): void;
  scrollRenderedY(nodeId: string): number | null;
  scrollProbe(nodeId?: string): Record<string, unknown>;

  /** Build-time child index for stage-owned trail planning. */
  liveChildIds(id: string): readonly string[] | undefined;
  liveAncestorChainHidden(node: MirrorNode): boolean;
  liveEffectivelyVisible(node: MirrorNode): boolean;
  dispose(): void;
}

interface FrameData {
  readonly raisePlan: HandRaisePlan;
  readonly cosmeticOffsets: ReadonlyMap<string, CosmeticOffset>;
  readonly spreadDxByNode: ReadonlyMap<string, number>;
  readonly spreadFieldModeByNode: ReadonlyMap<string, number>;
  readonly spreadFactor: number;
  readonly designWidth: number;
  readonly handHolderIds: ReadonlySet<string>;
  readonly raiseEnabled: boolean;
  interactiveRects: InteractiveRect[] | null;
  viewScaleInputStamps: ViewScaleInputStamp[] | null;
  children: Map<string, string[]> | null;
  handHolderParts: Map<string, { hitboxId: string | null; cardId: string | null; cardContentKey: string | null }>;
}

function copyPlan(plan: HandRaisePlan): HandRaisePlan {
  return {
    offsets: new Map(plan.offsets),
    movedRectDy: new Map(plan.movedRectDy),
    handHitboxes: new Map(plan.handHitboxes),
    creatureGroups: new Map(plan.creatureGroups),
    liftPx: plan.liftPx,
    gates: { ...plan.gates },
  };
}

function childIndex(nodes: ReadonlyMap<string, MirrorNode>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentId === null) continue;
    const children = index.get(node.parentId);
    if (children === undefined) index.set(node.parentId, [node.id]);
    else children.push(node.id);
  }
  return index;
}

function ancestorChainHidden(nodes: ReadonlyMap<string, MirrorNode>, node: MirrorNode): boolean {
  let current = node.parentId === null ? undefined : nodes.get(node.parentId);
  while (current !== undefined) {
    if (!current.visible) return true;
    current = current.parentId === null ? undefined : nodes.get(current.parentId);
  }
  return false;
}

function effectiveVisible(nodes: ReadonlyMap<string, MirrorNode>, node: MirrorNode): boolean {
  return node.visible && !ancestorChainHidden(nodes, node);
}

export function createCanvasInteractionRuntime(ports: CanvasInteractionRuntimePorts): CanvasInteractionRuntime {
  const cosmeticOffsets = new Map<string, CosmeticOffset>();
  const offsetRamps = createOffsetRamps();
  const rampSample: OffsetRampSample = { dx: 0, dy: 0 };
  const handHolderIds = new Set<string>();
  const snapshotData = new WeakMap<DrawnSceneSnapshot, FrameData>();
  // Queries compose one chain at a time on the JS event stack. Reuse the
  // ancestor scratch rather than allocating a temporary array per confirm or
  // diagnostics read.
  const snapshotGlobalChainScratch: MirrorNode[] = [];
  let viewScaleRegistryNodes: ReadonlyMap<string, MirrorNode> = EMPTY_NODES;
  let viewScaleRegistryOrderedIds: readonly string[] = EMPTY_ORDERED_IDS;
  // The registry does a cold, pointer-driven fold at most once per frame. Its
  // environment is stable; only these two snapshot facts move between folds.
  const viewScaleRegistryEnv: ViewScaleRegistryEnv = {
    parentIdOf: (id) => viewScaleRegistryNodes.get(id)?.parentId,
    get orderedIds() { return viewScaleRegistryOrderedIds; },
    ancestorChainHidden: (id) => {
      const node = viewScaleRegistryNodes.get(id);
      return node === undefined ? false : ancestorChainHidden(viewScaleRegistryNodes, node);
    },
    designWidth: MIRROR_DESIGN_WIDTH,
  };

  /** Streamed-only composition against the snapshot-owned drawn-scene map. */
  function composeSnapshotGlobalInto(snapshot: DrawnSceneSnapshot, id: string, out: number[]): boolean {
    const nodes = snapshot.scene.nodes;
    const start = nodes.get(id);
    const chain = snapshotGlobalChainScratch;
    chain.length = 0;
    if (start === undefined) return false;
    let current: MirrorNode | undefined = start;
    let guard = 0;
    while (current !== undefined && guard++ < 256) {
      chain.push(current);
      current = current.parentId === null ? undefined : nodes.get(current.parentId);
    }
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    out[4] = 0;
    out[5] = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      const transform = chain[i].transform;
      if (transform === null || transform === undefined || transform.length !== 6) continue;
      const a = out[0];
      const b = out[1];
      const c = out[2];
      const d = out[3];
      const e = out[4];
      const f = out[5];
      out[0] = a * transform[0] + c * transform[1];
      out[1] = b * transform[0] + d * transform[1];
      out[2] = a * transform[2] + c * transform[3];
      out[3] = b * transform[2] + d * transform[3];
      out[4] = a * transform[4] + c * transform[5] + e;
      out[5] = b * transform[4] + d * transform[5] + f;
    }
    chain.length = 0;
    return true;
  }

  let cosmeticVersion = 0;
  let cosmeticVersionAtBuild = 0;
  let offsetPending = false;
  let offsetBuildArmed = false;
  let offsetFrameRaf = 0;
  let offsetBuilds = 0;
  let offsetCoalesced = 0;
  let rampFrames = 0;

  let heldCardId: string | null = null;
  let heldMode: "drag" | "peek" = "drag";
  let heldFingerY = 0;
  let dragStartY: number | null = null;
  let heldEnteredPlayZone = false;
  let heldLifted = false;
  let targetingWorld: MirrorState | null = null;
  let targetingRevision = -1;
  let targetingActive = false;

  let raiseEnabled = false;
  let raisePlan: HandRaisePlan = EMPTY_HAND_RAISE_PLAN;
  const raiseOffsetIds = new Set<string>();
  let lastRaiseLift = 0;
  let raiseAtMs = 0;
  const raiseParentScratch: number[] = [1, 0, 0, 1, 0, 0];
  const raiseTweenEnv: HandRaiseTweenEnv = {
    transformEndpointInto: (id, out) => ports.loop().transformEndpointInto(id, out, raiseAtMs),
    parentGlobalY: (id) => ports.streamedGlobalInto(ports.state(), id, raiseParentScratch) ? raiseParentScratch[5] : null,
  };

  let liveChildIds: Map<string, string[]> | null = null;
  let liveChildIdsOrder: readonly string[] | null = null;
  let liveEagerCandidates: EagerScrollCandidate[] | null = null;
  let liveEagerCandidatesOrder: readonly string[] | null = null;
  const eagerGlobalScratch: number[] = [1, 0, 0, 1, 0, 0];

  function currentLiftPx(): number {
    return heldLiftPx(heldCardId !== null, heldMode, heldLifted);
  }

  function writeCosmeticOffset(id: string, dx: number, dy: number): boolean {
    const previous = cosmeticOffsets.get(id);
    if (dx === 0 && dy === 0) {
      if (previous === undefined) return false;
      cosmeticOffsets.delete(id);
      cosmeticVersion++;
      return true;
    }
    if (previous !== undefined && previous.dx === dx && previous.dy === dy) return false;
    cosmeticOffsets.set(id, { dx, dy });
    cosmeticVersion++;
    return true;
  }

  function setCosmeticOffset(id: string, dx: number, dy: number, ramp: OffsetRampTiming | null = null, at = 0): boolean {
    if (ramp === null) {
      if (offsetRamps.active() !== 0) offsetRamps.forget(id);
      return writeCosmeticOffset(id, dx, dy);
    }
    const previous = cosmeticOffsets.get(id);
    offsetRamps.declare(id, previous?.dx ?? 0, previous?.dy ?? 0, dx, dy, ramp, at, rampSample);
    return writeCosmeticOffset(id, rampSample.dx, rampSample.dy);
  }

  function invalidateSnapshotInputCaches(): void {
    const snapshot = ports.snapshot();
    if (snapshot === null) return;
    const data = snapshotData.get(snapshot);
    if (data !== undefined) {
      data.interactiveRects = null;
      data.viewScaleInputStamps = null;
    }
  }

  function targetingArrowVisible(): boolean {
    const state = ports.state();
    if (state === null) return false;
    if (state !== targetingWorld || state.revision !== targetingRevision) {
      targetingWorld = state;
      targetingRevision = state.revision;
      targetingActive = anyTargetingArrowVisible(state.nodes);
    }
    return targetingActive;
  }

  function applyHeldLift(): void {
    const id = heldCardId;
    const node = id === null ? undefined : ports.state()?.nodes.get(id);
    if (id === null || node === undefined || nodeTypeLeaf(node.nodeType) !== "NCard") return;
    const decided = decideHeldLift({
      mode: heldMode,
      targeting: targetingArrowVisible(),
      fingerY: heldFingerY,
      dragStartY,
      lifted: heldLifted,
      enteredPlayZone: heldEnteredPlayZone,
    });
    heldLifted = decided.lifted;
    heldEnteredPlayZone = decided.enteredPlayZone;
    setCosmeticOffset(id, 0, -currentLiftPx());
  }

  function raiseRampFor(id: string, liftChanged: boolean, liftPx: number, at: number): OffsetRampTiming | null {
    if (liftChanged || liftPx === 0) return RAISE_LIFT_RAMP;
    const timing = ports.loop().transformChannelTiming(id, at);
    return timing !== null && timing.durationMs > 0 ? timing : null;
  }

  function applyHandRaisePass(at = ports.now()): boolean {
    raiseAtMs = at;
    raisePlan = planCanvasHandRaise(
      ports.state(),
      { enabled: raiseEnabled, heldCardId, heldMode },
      raiseTweenEnv,
    );
    const liftChanged = raisePlan.liftPx !== lastRaiseLift;
    lastRaiseLift = raisePlan.liftPx;
    let moved = false;
    for (const [id, offset] of raisePlan.offsets) {
      if (setCosmeticOffset(id, offset.dx, offset.dy, raiseRampFor(id, liftChanged, raisePlan.liftPx, at), at)) moved = true;
      raiseOffsetIds.add(id);
    }
    for (const id of [...raiseOffsetIds]) {
      if (raisePlan.offsets.has(id)) continue;
      raiseOffsetIds.delete(id);
      const stillHere = ports.state()?.nodes.has(id) === true;
      if (setCosmeticOffset(id, 0, 0, liftChanged && stillHere ? RAISE_LIFT_RAMP : null, at)) moved = true;
    }
    if (moved) invalidateSnapshotInputCaches();
    return moved;
  }

  function advanceOffsetRamps(at: number): boolean {
    if (offsetRamps.active() === 0) return false;
    let moved = false;
    offsetRamps.advance(at, (id, dx, dy) => {
      if (writeCosmeticOffset(id, dx, dy)) moved = true;
    });
    if (moved) {
      rampFrames++;
      invalidateSnapshotInputCaches();
    }
    return moved;
  }

  function liveNodes(): ReadonlyMap<string, MirrorNode> {
    return ports.state()?.nodes ?? EMPTY_NODES;
  }

  function liveChildren(): Map<string, string[]> {
    const state = ports.state();
    const ordered = state?.orderedIds ?? null;
    if (liveChildIds !== null && liveChildIdsOrder === ordered) return liveChildIds;
    liveChildIds = childIndex(state?.nodes ?? EMPTY_NODES);
    liveChildIdsOrder = ordered;
    return liveChildIds;
  }

  function liveMapDrawingToolActive(): boolean {
    const nodes = liveNodes();
    for (const node of nodes.values()) {
      const url = node.textureUrl;
      if (url === null || url === undefined || !DRAWING_TOOL_ARMED_TEXTURES.some((suffix) => url.endsWith(suffix))) continue;
      if (effectiveVisible(nodes, node)) return true;
    }
    return false;
  }

  const liveEagerEnv: EagerScrollLayoutEnv = {
    orderedIds: () => ports.state()?.orderedIds ?? EMPTY_ORDERED_IDS,
    nodeById: (id) => ports.state()?.nodes.get(id),
    childIdsOf: (id) => liveChildren().get(id),
    typeLeafOf: (node) => nodeTypeLeaf(node.nodeType),
    streamedGlobalOf: (id) => ports.streamedGlobalInto(ports.state(), id, eagerGlobalScratch) ? eagerGlobalScratch : null,
    hasHost: (id) => ports.state()?.nodes.has(id) === true,
    spreadDxOf: (id) => ports.spreadDxByNode.get(id) ?? 0,
    renderedYOf: (id, fallback) => {
      const captured = ports.snapshot()?.capturedGlobals.get(id);
      return captured === undefined ? fallback : captured.g[5] - captured.parentTy;
    },
    ancestorHidden: (node) => ancestorChainHidden(liveNodes(), node),
    transformPinned: (id) => ports.loop().ownsTransform(id),
    drawingToolActive: liveMapDrawingToolActive,
  };

  function currentLiveEagerCandidates(): EagerScrollCandidate[] {
    const state = ports.state();
    const ordered = state?.orderedIds ?? null;
    if (liveEagerCandidates !== null && liveEagerCandidatesOrder === ordered) return liveEagerCandidates;
    liveEagerCandidates = state === null ? [] : scanEagerScrollIds(liveEagerEnv);
    liveEagerCandidatesOrder = ordered;
    return liveEagerCandidates;
  }

  function dataFor(snapshot: DrawnSceneSnapshot): FrameData {
    const data = snapshotData.get(snapshot);
    if (data === undefined) {
      // Every production snapshot is registered from the successful-build or
      // patch publication hooks.  The empty fallback keeps standalone unit
      // seams inert instead of ever consulting a newer live map.
      return {
        raisePlan: EMPTY_HAND_RAISE_PLAN,
        cosmeticOffsets: EMPTY_OFFSETS,
        spreadDxByNode: EMPTY_NUMBER_MAP,
        spreadFieldModeByNode: EMPTY_NUMBER_MAP,
        spreadFactor: 1,
        designWidth: MIRROR_DESIGN_WIDTH,
        handHolderIds: EMPTY_IDS,
        raiseEnabled: false,
        interactiveRects: null,
        viewScaleInputStamps: null,
        children: null,
        handHolderParts: new Map(),
      };
    }
    return data;
  }

  function snapshotChildren(snapshot: DrawnSceneSnapshot, data: FrameData): Map<string, string[]> {
    return data.children ??= childIndex(snapshot.scene.nodes);
  }

  function snapshotMapDrawingToolActive(snapshot: DrawnSceneSnapshot): boolean {
    for (const node of snapshot.scene.nodes.values()) {
      const url = node.textureUrl;
      if (url === null || url === undefined || !DRAWING_TOOL_ARMED_TEXTURES.some((suffix) => url.endsWith(suffix))) continue;
      if (effectiveVisible(snapshot.scene.nodes, node)) return true;
    }
    return false;
  }

  function prepareBuild(): void {
    offsetPending = false;
    cosmeticVersionAtBuild = cosmeticVersion;
  }

  function publishBuild(snapshot: DrawnSceneSnapshot): void {
    snapshotData.set(snapshot, {
      // The plan and offset maps describe the geometry that this exact build
      // received. Later retained-state writes must not reinterpret its hits.
      raisePlan: copyPlan(raisePlan),
      cosmeticOffsets: new Map(cosmeticOffsets),
      spreadDxByNode: new Map(ports.spreadDxByNode),
      spreadFieldModeByNode: new Map(ports.spreadFieldModeByNode),
      spreadFactor: ports.spreadFactor(),
      designWidth: ports.designWidth(),
      handHolderIds: new Set(handHolderIds),
      raiseEnabled,
      interactiveRects: null,
      viewScaleInputStamps: null,
      children: null,
      handHolderParts: new Map(),
    });
  }

  function publishPatch(previous: DrawnSceneSnapshot | null, snapshot: DrawnSceneSnapshot): void {
    const data = previous === null ? undefined : snapshotData.get(previous);
    if (data === undefined) {
      // This only covers standalone test seams. Production patches always
      // originate from a successfully published full snapshot.
      publishBuild(snapshot);
      return;
    }
    // A retained patch receives a new hit list. Do not let the new picture reuse old rect/provenance caches:
    // a 5→4 hand reflow otherwise proves the prior fourth-card footprint against the new frame. Keep every other
    // snapshot-latched policy/plan value exactly as the existing patch contract did; only products derived from the
    // previous hit list or previous node map are rebuilt for this snapshot.
    snapshotData.set(snapshot, {
      ...data,
      interactiveRects: null,
      viewScaleInputStamps: null,
      children: null,
      handHolderParts: new Map(),
    });
  }

  function collectCaptureIds(out: Set<string>): void {
    if (heldCardId !== null) out.add(heldCardId);
    for (const id of cosmeticOffsets.keys()) out.add(id);
    for (const candidate of currentLiveEagerCandidates()) out.add(candidate.id);
    for (const holderId of handHolderIds) out.add(holderId);
  }

  function interactiveRectsFor(snapshot: DrawnSceneSnapshot, data: FrameData): InteractiveRect[] {
    if (data.interactiveRects !== null) return data.interactiveRects;
    const rects: InteractiveRect[] = [];
    for (const entry of snapshot.hitEntries) {
      if (!entry.mouseVisible) continue;
      rects.push({
        id: entry.nodeId,
        transform: entry.mGame,
        localRect: entry.localRect,
        spreadDx: entry.spreadDx,
        renderedWidth: entry.renderedWidth,
        raiseDy: data.raisePlan.movedRectDy.get(entry.nodeId) ?? 0,
        raiseGoverned: data.raisePlan.movedRectDy.size > 0 && data.raisePlan.handHitboxes.has(entry.nodeId),
      });
    }
    data.interactiveRects = rects;
    return rects;
  }

  function snapshotOrNull(): DrawnSceneSnapshot | null {
    return ports.snapshot();
  }

  function raiseInputStamps(): RaiseInputStamp[] {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return [];
    const data = dataFor(snapshot);
    if (data.raisePlan.movedRectDy.size === 0) return [];
    const out: RaiseInputStamp[] = [];
    const hand: Array<{ stamp: RaiseInputStamp; z: number; order: number }> = [];
    for (const rect of interactiveRectsFor(snapshot, data)) {
      const holderId = data.raisePlan.handHitboxes.get(rect.id);
      if (holderId !== undefined) {
        hand.push({
          stamp: {
            transform: rect.transform,
            localRect: rect.localRect,
            spreadDx: rect.spreadDx,
            dy: rect.raiseDy,
            ownerId: holderId,
          },
          z: snapshot.scene.nodes.get(holderId)?.zIndex ?? 0,
          order: hand.length,
        });
      } else if (rect.raiseDy !== 0) {
        out.push({ transform: rect.transform, localRect: rect.localRect, spreadDx: rect.spreadDx, dy: rect.raiseDy });
      }
    }
    hand.sort((left, right) => left.z - right.z || left.order - right.order);
    for (const entry of hand) out.push(entry.stamp);
    return out;
  }

  function handPresent(): boolean {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return false;
    for (const node of snapshot.scene.nodes.values()) {
      if (nodeTypeLeaf(node.nodeType) === HAND_HOLDER_TYPE && effectiveVisible(snapshot.scene.nodes, node)) return true;
    }
    return false;
  }

  function coverAbove(id: string): boolean {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return false;
    const targetIndex = snapshot.paintOrder.orderOf(id);
    if (targetIndex < 0) return false;
    const nodes = snapshot.scene.nodes;
    const designWidth = dataFor(snapshot).designWidth;
    for (const node of nodes.values()) {
      if (!node.fillColor || (node.shaderId !== null && node.shaderId !== undefined) || node.localRect === null || !node.visible) continue;
      if (snapshot.paintOrder.orderOf(node.id) <= targetIndex || ancestorChainHidden(nodes, node)) continue;
      const own = (node.modulate?.a ?? node.opacity) * (node.selfModulate?.a ?? 1) * node.fillColor.a;
      const alpha = composeCoverAlpha(nodes, node, () => own, (candidate) => candidate.modulate?.a ?? candidate.opacity, COVER_CHAIN_BUDGET);
      if (alpha < BACKSTOP_COVER_MIN_ALPHA) continue;
      const transform = node.transform;
      if (transform === null || transform === undefined || Math.abs(transform[1]) > 1e-4 || Math.abs(transform[2]) > 1e-4 || transform[0] <= 0 || transform[3] <= 0) continue;
      const rect = node.localRect;
      const x0 = transform[4] + transform[0] * rect.x;
      const y0 = transform[5] + transform[3] * rect.y;
      if (
        x0 <= COVER_EDGE_EPS && y0 <= COVER_EDGE_EPS &&
        x0 + rect.width * transform[0] >= designWidth - COVER_EDGE_EPS &&
        y0 + rect.height * transform[3] >= MIRROR_DESIGN_HEIGHT - COVER_EDGE_EPS
      ) return true;
    }
    return false;
  }

  function handRaiseUiLayer(): HandRaiseUiLayer {
    const snapshot = snapshotOrNull();
    const anchorId = snapshot?.build.handRaiseAnchorId ?? null;
    const present = anchorId !== null && handPresent();
    return {
      present,
      anchorId: present ? anchorId : null,
      domTarget: null,
      covered: present ? coverAbove(anchorId) : false,
      backend: "canvas",
    };
  }

  function isHandCard(id: string): boolean {
    const snapshot = snapshotOrNull();
    return snapshot !== null && isSharedHandCard(snapshot.scene.nodes, id);
  }

  function isCardTouchTarget(id: string): boolean {
    const snapshot = snapshotOrNull();
    const leaf = snapshot?.scene.nodes.get(id);
    return CARD_TOUCH_TARGET_TYPES.has(nodeTypeLeaf(leaf?.nodeType ?? ""));
  }

  function confirmKindOf(nodes: ReadonlyMap<string, MirrorNode>, id: string): ConfirmTapKind | null {
    return confirmTapEligible(
      nodes.get(id),
      (candidate) => isSharedHandCard(nodes, candidate),
      (candidate, suffix) => hasAncestorSceneFile(nodes, candidate, suffix),
      (candidate, name) => hasVisibleDirectChild(nodes, candidate, name),
    );
  }

  function confirmTapTarget(id: string): ConfirmTapKind | null {
    const snapshot = snapshotOrNull();
    return snapshot === null ||
      hasEffectivelyVisibleCardGridSelection(snapshot.scene.nodes) ||
      hasEffectivelyVisibleDeckCardSelectScreen(snapshot.scene.nodes)
      ? null
      : confirmKindOf(snapshot.scene.nodes, id);
  }

  function sceneFileOf(nodes: ReadonlyMap<string, MirrorNode>, id: string): string | null {
    for (let current = nodes.get(id); current !== undefined; current = current.parentId === null ? undefined : nodes.get(current.parentId)) {
      if (current.sceneFilePath !== null) return current.sceneFilePath;
    }
    return null;
  }

  function countVisibleEventOptions(nodes: ReadonlyMap<string, MirrorNode>): number {
    let count = 0;
    for (const node of nodes.values()) {
      if (nodeTypeLeaf(node.nodeType) !== "NEventOptionButton" || !effectiveVisible(nodes, node)) continue;
      if (++count > 1) break;
    }
    return count;
  }

  const confirmGlobalScratch: Affine = [1, 0, 0, 1, 0, 0];

  function confirmGameGlobal(snapshot: DrawnSceneSnapshot, id: string, hasTransform: boolean): Affine | null {
    return hasTransform && composeSnapshotGlobalInto(snapshot, id, confirmGlobalScratch) ? confirmGlobalScratch : null;
  }

  function confirmHitBox(
    snapshot: DrawnSceneSnapshot,
    node: MirrorNode,
    kind: ConfirmTapKind,
  ): { transform: Affine; localRect: MirrorRect } | null {
    if (kind === "reward") {
      const transform = confirmGameGlobal(snapshot, node.id, node.transform?.length === 6);
      return transform === null
        ? null
        : { transform, localRect: { x: -VIEW_SCALE_NOMINAL_CARD_W / 2, y: -VIEW_SCALE_NOMINAL_CARD_H / 2, width: VIEW_SCALE_NOMINAL_CARD_W, height: VIEW_SCALE_NOMINAL_CARD_H } };
    }
    if (kind === "shop") {
      for (const childId of snapshot.paintOrder.childrenOf(node.id)) {
        const child = snapshot.scene.nodes.get(childId);
        if (child?.name !== "Hitbox" || child.localRect === null || child.transform?.length !== 6) continue;
        const transform = confirmGameGlobal(snapshot, child.id, true);
        if (transform !== null) return { transform, localRect: child.localRect };
      }
    }
    if (node.localRect === null || node.localRect.width <= 0 || node.localRect.height <= 0) return null;
    const transform = confirmGameGlobal(snapshot, node.id, node.transform?.length === 6);
    return transform === null ? null : { transform, localRect: node.localRect };
  }

  function confirmTapAt(gameX: number, gameY: number): ConfirmTapHit | null {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return null;
    const nodes = snapshot.scene.nodes;
    if (
      hasEffectivelyVisibleCardGridSelection(nodes) ||
      hasEffectivelyVisibleDeckCardSelectScreen(nodes)
    ) {
      return null;
    }
    let hit: ConfirmTapHit | null = null;
    let loneEventOption: boolean | null = null;
    for (const node of nodes.values()) {
      const kind = confirmKindOf(nodes, node.id);
      if (kind === null || !effectiveVisible(nodes, node)) continue;
      if (kind === "event") {
        if (sceneFileOf(nodes, node.id)?.endsWith(PROCEED_BUTTON_SCENE_FILE_SUFFIX)) continue;
        loneEventOption ??= countVisibleEventOptions(nodes) === 1;
        if (loneEventOption) continue;
      }
      if (kind === "reward" && hasEchoAncestor(nodes, node)) continue;
      const box = confirmHitBox(snapshot, node, kind);
      if (box === null || !pointInPlacedRect(box.transform, box.localRect, gameX, gameY)) continue;
      if (hit === null || snapshot.paintOrder.orderOf(node.id) > snapshot.paintOrder.orderOf(hit.id)) {
        hit = {
          id: node.id,
          kind,
          ...(nodeTypeLeaf(node.nodeType) === "NMerchantCardRemoval" ? { retapActivates: true } : {})
        };
      }
    }
    return hit;
  }

  function handChoiceActive(): boolean {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return false;
    for (const node of snapshot.scene.nodes.values()) {
      const leaf = nodeTypeLeaf(node.nodeType);
      if ((!HAND_CHOICE_TYPES.has(leaf) && !HAND_CHOICE_NAMES.has(node.name)) || !effectiveVisible(snapshot.scene.nodes, node)) continue;
      return true;
    }
    return false;
  }

  function interactiveRects(): InteractiveRect[] {
    const snapshot = snapshotOrNull();
    return snapshot === null ? [] : interactiveRectsFor(snapshot, dataFor(snapshot));
  }

  function viewScaleInputStamps(): ViewScaleInputStamp[] {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return EMPTY_VIEW_SCALE_STAMPS;
    const data = dataFor(snapshot);
    if (data.viewScaleInputStamps !== null) return data.viewScaleInputStamps;
    const stamps = snapshot.build.viewScaleStamps;
    if (stamps.size === 0) {
      data.viewScaleInputStamps = EMPTY_VIEW_SCALE_STAMPS;
      return data.viewScaleInputStamps;
    }
    viewScaleRegistryNodes = snapshot.scene.nodes;
    viewScaleRegistryOrderedIds = snapshot.paintOrder.ids;
    data.viewScaleInputStamps = buildViewScaleInputRegistry(stamps, interactiveRectsFor(snapshot, data), viewScaleRegistryEnv);
    return data.viewScaleInputStamps;
  }

  function endTurnBoxAt(gameX: number, gameY: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (const entry of snapshot.hitEntries) {
      if (entry.sceneFile === null || !entry.sceneFile.endsWith(END_TURN_SCENE_FILE_SUFFIX)) continue;
      const transform = entry.mGame;
      const rect = entry.localRect;
      const x0 = transform[0] * rect.x + transform[2] * rect.y + transform[4];
      const y0 = transform[1] * rect.x + transform[3] * rect.y + transform[5];
      for (const [x, y] of [[0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height]] as const) {
        const px = transform[0] * x + transform[2] * y + x0;
        const py = transform[1] * x + transform[3] * y + y0;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      any = true;
    }
    return any && gameX >= minX && gameX <= maxX && gameY >= minY && gameY <= maxY ? { minX, minY, maxX, maxY } : null;
  }

  function eagerScrollTargets(): EagerScrollTarget[] {
    // Eager scroll intentionally compares two clocks: `streamedY` belongs to
    // the newest retained wire state so its controller can follow the drag,
    // while `renderedYOf` below reads the published capture from the last
    // canvas picture. Do not turn this into a painted-geometry query.
    return buildEagerScrollTargets(currentLiveEagerCandidates(), liveEagerEnv);
  }

  function isUnderNode(id: string, ancestorId: string): boolean {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return false;
    let current: string | null | undefined = id;
    let guard = 0;
    while (current !== null && current !== undefined && guard++ < 512) {
      if (current === ancestorId) return true;
      current = snapshot.scene.nodes.get(current)?.parentId;
    }
    return false;
  }

  function toDesign(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = ports.stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const width = ports.stage.clientWidth || rect.width;
    const height = ports.stage.clientHeight || rect.height;
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * height,
    };
  }

  function touchStackAt(clientX: number, clientY: number): TouchStack {
    const snapshot = snapshotOrNull();
    const point = toDesign(clientX, clientY);
    if (snapshot === null || point === null) return { ids: [], blocked: false, blockKind: null, topStamp: null };
    const ids: string[] = [];
    let topStamp: TouchStack["topStamp"] = null;
    for (const entry of hitStack(snapshot.hitEntries, point.x, point.y)) {
      if (entry.touchOwnerId !== null) {
        topStamp ??= "other";
        if (!ids.includes(entry.touchOwnerId)) ids.push(entry.touchOwnerId);
        continue;
      }
      if (entry.touchBlock !== null) {
        topStamp ??= entry.touchBlock === "button" ? "other" : entry.touchBlock;
        return { ids, blocked: true, blockKind: entry.touchBlock, topStamp };
      }
    }
    return { ids, blocked: false, blockKind: null, topStamp };
  }

  function spreadPainterAt(clientX: number, clientY: number, backdropWidthPx: number): SpreadPainter | null | undefined {
    const snapshot = snapshotOrNull();
    const point = toDesign(clientX, clientY);
    if (point === null) return undefined;
    if (snapshot === null) return null;
    const scale = ports.stageScale();
    for (const entry of hitStack(snapshot.hitEntries, point.x, point.y)) {
      if (!entry.paints) continue;
      const widthPx = Math.abs(entry.localRect.width * entry.mFinal[0]) * scale;
      if (entry.renderedWidth > 0 || widthPx >= backdropWidthPx) continue;
      return { dx: entry.spreadDx, prop: entry.spreadProp, widthPx };
    }
    return null;
  }

  function mapNodeAt(clientX: number, clientY: number): string | null {
    const snapshot = snapshotOrNull();
    const point = toDesign(clientX, clientY);
    if (snapshot === null || point === null) return null;
    for (const entry of hitStack(snapshot.hitEntries, point.x, point.y)) {
      if (entry.sceneFile?.endsWith(MAP_POINT_SCENE_FILE_SUFFIX) && entry.sceneRootId !== null) return entry.sceneRootId;
      if (entry.touchBlock !== null) return null;
    }
    return null;
  }

  function raisedHandVisualClaimAt(clientX: number, clientY: number): RaisedHandVisualClaim | null {
    const snapshot = snapshotOrNull();
    const point = toDesign(clientX, clientY);
    if (snapshot === null || point === null) return null;
    const data = dataFor(snapshot);
    if (data.raisePlan.movedRectDy.size === 0) return null;
    for (const entry of hitStack(snapshot.hitEntries, point.x, point.y)) {
      // A drawn snapshot is the canvas equivalent of DOM's current painted-descendant stack.  Layout entries cannot
      // prove a visual claim merely because they share a hand-holder ancestor.
      if (!entry.paints) continue;
      let current: string | null | undefined = entry.nodeId;
      let guard = 0;
      while (current != null && guard++ < 256) {
        if (nodeTypeLeaf(snapshot.scene.nodes.get(current)?.nodeType ?? "") === HAND_HOLDER_TYPE) {
          const holder = snapshot.scene.nodes.get(current);
          const parent = holder?.parentId === null ? undefined : snapshot.scene.nodes.get(holder?.parentId ?? "");
          if (parent?.name === HAND_CONTAINER_NAME) {
            // Both halves of this proof come from the one published snapshot.  In particular, do not fall back to
            // a retained game/spread stamp here: that is exactly what is stale during the 5→4 reflow.
            const withinCurrentFootprint = snapshot.hitEntries.some((hit) => {
              const hitNode = snapshot.scene.nodes.get(hit.nodeId);
              return hitNode !== undefined && hitNode.parentId === current &&
                hitNode.name === "Hitbox" &&
                pointWithinPlacedRectMargin(hit.mFinal, hit.localRect, point.x, point.y);
            });
            if (withinCurrentFootprint) return { ownerId: current };
            // This foreground hand descendant is decorative at this pixel. Keep walking the snapshot's paint
            // stack: a lower painted holder may legitimately own the same point through its own footprint.
            break;
          }
          break;
        }
        current = snapshot.scene.nodes.get(current)?.parentId;
      }
    }
    return null;
  }

  /** The canvas twin of the DOM touch-owner bridge: only the current snapshot's top touch target may nominate it. */
  function raisedHandTouchTargetClaim(touchTargetId: string): RaisedHandVisualClaim | null {
    const snapshot = snapshotOrNull();
    if (snapshot === null) return null;
    const data = dataFor(snapshot);
    if (data.raisePlan.movedRectDy.size === 0) return null;
    let current: string | null | undefined = touchTargetId;
    let guard = 0;
    while (current != null && guard++ < 256) {
      const node = snapshot.scene.nodes.get(current);
      if (nodeTypeLeaf(node?.nodeType ?? "") === HAND_HOLDER_TYPE) {
        const parent = node?.parentId === null ? undefined : snapshot.scene.nodes.get(node?.parentId ?? "");
        if (parent?.name !== HAND_CONTAINER_NAME) return null;
        for (const [hitboxId, ownerId] of data.raisePlan.handHitboxes) {
          // Like DOM: the focused holder itself has dy 0 and therefore no movedRectDy entry, while a neighbour
          // proves raised-hand mode remains active. The exact top touch target is sufficient provenance here.
          if (ownerId === current) return { ownerId: current };
        }
        return null;
      }
      current = node?.parentId;
    }
    return null;
  }

  function armOffsetFrame(): void {
    if (offsetFrameRaf !== 0 || ports.disposed() || typeof requestAnimationFrame !== "function") return;
    offsetFrameRaf = requestAnimationFrame(() => {
      offsetFrameRaf = 0;
      offsetBuildArmed = false;
      if (!offsetPending) return;
      offsetPending = false;
      offsetBuildArmed = true;
      offsetBuilds++;
      ports.rebuildAndPaint();
      armOffsetFrame();
    });
  }

  function applyLocalOffset(nodeId: string, dy: number): void {
    if (!ports.state()?.nodes.has(nodeId)) return;
    if (!setCosmeticOffset(nodeId, 0, Math.abs(dy) < 0.01 ? 0 : dy)) return;
    if (offsetBuildArmed) {
      offsetPending = true;
      offsetCoalesced++;
      armOffsetFrame();
      return;
    }
    offsetBuildArmed = true;
    offsetBuilds++;
    ports.rebuildAndPaint();
    armOffsetFrame();
  }

  function scrollRenderedY(nodeId: string): number | null {
    const captured = snapshotOrNull()?.capturedGlobals.get(nodeId);
    return captured === undefined ? null : captured.g[5] - captured.parentTy;
  }

  function scrollProbe(nodeId?: string): Record<string, unknown> {
    const snapshot = snapshotOrNull();
    if (snapshot === null) {
      return {
        backend: "canvas", id: null, targets: 0, baseY: null, offsetY: 0, composedY: null, globalY: null,
        builds: ports.builds(), offsetBuilds, offsetCoalesced, frames: ports.paintedFrames(),
      };
    }
    const candidates = currentLiveEagerCandidates();
    const id = nodeId ?? candidates[0]?.id ?? null;
    const captured = id === null ? undefined : snapshot.capturedGlobals.get(id);
    const baseY = captured === undefined ? null : captured.g[5] - captured.parentTy;
    const offsetY = id === null ? 0 : (cosmeticOffsets.get(id)?.dy ?? 0);
    return {
      backend: "canvas",
      id,
      targets: candidates.length,
      baseY,
      offsetY,
      composedY: baseY === null ? null : baseY + offsetY,
      globalY: captured === undefined ? null : captured.g[5] + offsetY,
      builds: ports.builds(),
      offsetBuilds,
      offsetCoalesced,
      frames: ports.paintedFrames(),
    };
  }

  function setHeldCard(id: string | null, gameY: number, mode: "drag" | "peek" = "drag"): void {
    heldFingerY = gameY;
    if (id !== heldCardId) {
      if (heldCardId !== null && setCosmeticOffset(heldCardId, 0, 0)) ports.rebuildAndPaint();
      heldCardId = id;
      heldMode = mode;
      heldLifted = false;
      dragStartY = gameY;
      heldEnteredPlayZone = false;
      targetingWorld = null;
    } else {
      heldMode = mode;
    }
    const before = cosmeticOffsets.get(id ?? "")?.dy ?? 0;
    applyHeldLift();
    const after = cosmeticOffsets.get(id ?? "")?.dy ?? 0;
    const raiseMoved = applyHandRaisePass();
    if (before !== after || raiseMoved) ports.rebuildAndPaint();
    ports.armAnimation();
  }

  function setRaiseHandCards(enabled: boolean): void {
    if (enabled === raiseEnabled) return;
    raiseEnabled = enabled;
    if (applyHandRaisePass()) ports.rebuildAndPaint();
    ports.armAnimation();
  }

  function noteNodePresent(node: MirrorNode): void {
    if (nodeTypeLeaf(node.nodeType) === HAND_HOLDER_TYPE) handHolderIds.add(node.id);
  }

  function noteNodeRemoved(id: string): void {
    handHolderIds.delete(id);
  }

  function noteRewrite(): void {
    handHolderIds.clear();
  }

  function liveChildIdsOf(id: string): readonly string[] | undefined {
    return liveChildren().get(id);
  }

  function handPoses(): HandPoseReport {
    const snapshot = snapshotOrNull();
    const holders: HandPoseSample[] = [];
    const scratch: number[] = [0, 0, 0, 0, 0, 0];
    const endpoint: number[] = [0, 0, 0, 0, 0, 0];
    const at = ports.now();
    if (snapshot !== null) {
      const data = dataFor(snapshot);
      let children: Map<string, string[]> | null = null;
      for (const id of data.handHolderIds) {
        const node = snapshot.scene.nodes.get(id);
        if (node === undefined) continue;
        let parts = data.handHolderParts.get(id);
        if (parts === undefined) {
          children ??= snapshotChildren(snapshot, data);
          parts = { hitboxId: null, cardId: null, cardContentKey: null };
          for (const childId of children.get(id) ?? []) {
            const child = snapshot.scene.nodes.get(childId);
            if (child?.name === "Hitbox") parts.hitboxId = childId;
            else if (child !== undefined && nodeTypeLeaf(child.nodeType) === "NCard") {
              parts.cardId = childId;
              parts.cardContentKey = child.contentKey;
            }
          }
          data.handHolderParts.set(id, parts);
        }
        const captured = snapshot.capturedGlobals.get(id);
        const mGame: Affine = composeSnapshotGlobalInto(snapshot, id, scratch)
          ? [scratch[0], scratch[1], scratch[2], scratch[3], scratch[4], scratch[5]]
          : IDENTITY_AFFINE;
        const parent = node.parentId === null ? undefined : snapshot.scene.nodes.get(node.parentId);
        const hasEndpoint = ports.loop().transformEndpointInto(id, endpoint, at);
        holders.push({
          id,
          name: node.name,
          inFan: parent?.name === HAND_CONTAINER_NAME,
          mGame,
          mDrawn: captured?.drawn ?? mGame,
          spreadDx: data.spreadDxByNode.get(id) ?? 0,
          fieldMode: data.spreadFieldModeByNode.get(id) ?? -1,
          raiseDy: data.cosmeticOffsets.get(id)?.dy ?? 0,
          zIndex: node.zIndex ?? 0,
          hitboxId: parts.hitboxId,
          cardId: parts.cardId,
          cardContentKey: parts.cardContentKey,
          endpoint: hasEndpoint ? [endpoint[0], endpoint[1], endpoint[2], endpoint[3], endpoint[4], endpoint[5]] : null,
          channelLive: ports.loop().ownsTransform(id),
        });
      }
      return {
        stage: "canvas",
        atMs: at,
        spreadFactor: data.spreadFactor,
        handPresent: data.handHolderIds.size > 0,
        holders,
      };
    }
    return { stage: "canvas", atMs: at, spreadFactor: 1, handPresent: false, holders };
  }

  function raiseProbe(): Record<string, unknown> {
    const snapshot = snapshotOrNull();
    const data = snapshot === null ? undefined : dataFor(snapshot);
    const plan = data?.raisePlan ?? EMPTY_HAND_RAISE_PLAN;
    const groups: Record<string, unknown>[] = [];
    const creatures: Record<string, unknown>[] = [];
    const holders: Record<string, unknown>[] = [];
    if (snapshot !== null && data !== undefined) {
      const nodes = snapshot.scene.nodes;
      const scratch: number[] = [0, 0, 0, 0, 0, 0];
      const childrenOf = snapshotChildren(snapshot, data);
      const measured = new Map<string, CreatureHudMeasure>();
      const globalY = (id: string): number | null => composeSnapshotGlobalInto(snapshot, id, scratch) ? scratch[5] : null;
      for (const [groupId, rootId] of plan.creatureGroups) {
        let measurement = measured.get(rootId);
        if (measurement === undefined) {
          measurement = creatureHudMeasure(nodes, (id) => childrenOf.get(id) ?? EMPTY_ORDERED_IDS, rootId);
          measured.set(rootId, measurement);
        }
        const parentId = nodes.get(groupId)?.parentId ?? null;
        const parentY = parentId === null || !composeSnapshotGlobalInto(snapshot, parentId, scratch) ? null : scratch[5];
        const parentScaleY = parentId === null || !composeSnapshotGlobalInto(snapshot, parentId, scratch) ? null : scratch[3];
        const streamedY = globalY(groupId);
        const dy = data.cosmeticOffsets.get(groupId)?.dy ?? 0;
        groups.push({
          id: groupId,
          name: nodes.get(groupId)?.name ?? null,
          rootId,
          dy,
          parentScaleY,
          parentGlobalY: parentY,
          streamedY,
          drawnY: streamedY === null ? null : streamedY + dy,
        });
      }
      for (const [rootId, measurement] of measured) {
        const childOf = (parentId: string, name: string): string | null => {
          for (const childId of childrenOf.get(parentId) ?? EMPTY_ORDERED_IDS) {
            if (nodes.get(childId)?.name === name) return childId;
          }
          return null;
        };
        const drawnY = (id: string | null): number | null => {
          if (id === null) return null;
          const y = globalY(id);
          return y === null ? null : y + (data.cosmeticOffsets.get(id)?.dy ?? 0);
        };
        const reticleDrawnY = drawnY(childOf(rootId, "SelectionReticle"));
        const displayDrawnY = drawnY(childOf(rootId, "HealthBar"));
        const powerBottomY = displayDrawnY === null ? null : displayDrawnY + (measurement.powerTop - measurement.displayTop) + CREATURE_POWER_ROW_H;
        creatures.push({
          rootId,
          ...measurement,
          reticleDrawnY,
          displayDrawnY,
          powerBottomY,
          powerGap: reticleDrawnY === null || powerBottomY === null ? null : reticleDrawnY - powerBottomY,
        });
      }
      for (const [id, offset] of plan.offsets) {
        if (plan.creatureGroups.has(id)) continue;
        const streamedY = globalY(id);
        const parentId = nodes.get(id)?.parentId ?? null;
        const parentScaleY = parentId === null || !composeSnapshotGlobalInto(snapshot, parentId, scratch) ? null : scratch[3];
        holders.push({
          id,
          dy: offset.dy,
          streamedY,
          parentScaleY,
          drawnY: streamedY === null ? null : streamedY + offset.dy,
        });
      }
    }
    return {
      backend: "canvas",
      enabled: data?.raiseEnabled ?? false,
      liftPx: plan.liftPx,
      gates: plan.gates,
      viewScaleStamps: snapshot?.build.viewScaleStamps.size ?? 0,
      holders,
      groups,
      creatures,
    };
  }

  function raiseDebug(): CanvasInteractionRuntime["raiseDebug"] extends () => infer Result ? Result : never {
    const snapshot = snapshotOrNull();
    const plan = snapshot === null ? EMPTY_HAND_RAISE_PLAN : dataFor(snapshot).raisePlan;
    return {
      enabled: snapshot === null ? false : dataFor(snapshot).raiseEnabled,
      liftPx: plan.liftPx,
      maxLiftPx: HAND_RAISE_PX,
      gates: plan.gates,
      offsets: plan.offsets.size,
      movedRects: plan.movedRectDy.size,
      stamps: raiseInputStamps().length,
    };
  }

  function dispose(): void {
    if (offsetFrameRaf !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(offsetFrameRaf);
    offsetFrameRaf = 0;
    offsetRamps.clear();
    handHolderIds.clear();
    liveChildIds = null;
    liveEagerCandidates = null;
    snapshotGlobalChainScratch.length = 0;
    viewScaleRegistryNodes = EMPTY_NODES;
    viewScaleRegistryOrderedIds = EMPTY_ORDERED_IDS;
  }

  return {
    get cosmeticOffsets() { return cosmeticOffsets; },
    get handHolderIds() { return handHolderIds; },
    get cosmeticVersion() { return cosmeticVersion; },
    get cosmeticVersionAtBuild() { return cosmeticVersionAtBuild; },
    get offsetPending() { return offsetPending; },
    get offsetRampDeadline() { return offsetRamps.nextDeadline(); },
    get offsetBuilds() { return offsetBuilds; },
    get offsetCoalesced() { return offsetCoalesced; },
    get rampFrames() { return rampFrames; },
    prepareBuild,
    publishBuild,
    publishPatch,
    invalidateInputCaches: invalidateSnapshotInputCaches,
    collectCaptureIds,
    noteNodePresent,
    noteNodeRemoved,
    noteRewrite,
    applyHeldLift,
    applyHandRaisePass,
    advanceOffsetRamps,
    setHeldCard,
    setRaiseHandCards,
    raiseInputStamps,
    raisedHandVisualClaimAt,
    raisedHandTouchTargetClaim,
    handPresent,
    handRaiseUiLayer,
    handPoses,
    raiseProbe,
    raiseDebug,
    isCardTouchTarget,
    isHandCard,
    confirmTapTarget,
    confirmTapAt,
    coverAbove,
    handChoiceActive,
    mapDrawingToolActive: () => {
      const snapshot = snapshotOrNull();
      return snapshot !== null && snapshotMapDrawingToolActive(snapshot);
    },
    interactiveRects,
    viewScaleInputStamps,
    endTurnBoxAt,
    eagerScrollTargets,
    isUnderNode,
    touchStackAt,
    spreadPainterAt,
    mapNodeAt,
    applyLocalOffset,
    scrollRenderedY,
    scrollProbe,
    liveChildIds: liveChildIdsOf,
    liveAncestorChainHidden: (node) => ancestorChainHidden(liveNodes(), node),
    liveEffectivelyVisible: (node) => effectiveVisible(liveNodes(), node),
    dispose,
  };
}
