/**
 * Admission and publication boundary for canvas in-place patches.
 *
 * The draw list is deliberately edited in place for the hot path.  Its frame
 * identity is not: every successful edit is published through frameRuntime,
 * so input, diagnostics and a later patch see one updated snapshot.  Failed
 * admission returns null and cannot advance any epoch or present pixels.
 */
import type { MirrorNode, MirrorState } from "@/mirror/sceneTree";
import {
  PATCH_CHAIN_MAX,
  PATCH_TRANSFORM_CHAIN_MAX,
  PATCH_BAIL_REASONS,
  applyOpacityPlan,
  applySourcePlan,
  applyTransformPlan,
  createPatchScratch,
  createTransformScratch,
  patchOpacity,
  planOpacity,
  planSource,
  planTransform,
  type PatchAnimFrame,
  type PatchBailReason,
  type PatchEnv,
  type PatchOutcome,
  type SourcePatch,
  type SourcePatchTarget,
  type TransformOutcome,
  type TransformPatchEnv,
} from "@/mirror/canvas/listPatch";
import { type DrawList, type ExecutorTexture } from "@godot-scene-web/canvas";
import { createPaintScratch } from "@/mirror/canvas/paintSpec";
import type { AlphaOverride, LocalAnim } from "@/mirror/canvas/buildDrawList";
import {
  commitWireDelta,
  createWireDeltaScratch,
  planWireDelta,
  type WireDeltaBuildCause,
  type WireDeltaGraph,
  type WireNodeSnapshot,
} from "@/mirror/canvas/wireDeltaGraph";
import {
  SAMPLE_NONE,
  SAMPLE_SOURCE,
  SAMPLE_TRANSFORM,
} from "@/mirror/canvas/tweenLoop";
import type { CanvasFrameRuntime, DrawnSceneSnapshot } from "./frameRuntime";

/** Proven empty wire delta for coalesced no-op revisions; never allocate per frame. */
const NO_CHANGED_IDS: readonly string[] = Object.freeze([]);

/** Everything the list-patch policy needs, reduced to already-built facts. */
export interface AnimationPatchAdmission {
  readonly state: MirrorState | null;
  readonly hasBuild: boolean;
  readonly hasOrder: boolean;
  readonly contextLost: boolean;
  readonly patchChain: number;
  readonly transformChain: number;
  readonly sampleMask: number;
  readonly noSampleMask: number;
  readonly opacitySamples: number;
  readonly animRoots: boolean;
  readonly sourceSamples: boolean;
  readonly transformSamples: boolean;
  readonly hasUnknownAnim: boolean;
  readonly offsetPending: boolean;
  readonly cosmeticCurrent: number;
  readonly cosmeticAtBuild: number;
  readonly trailLatchCurrent: number;
  readonly trailLatchAtBuild: number;
  readonly trailDue: boolean;
  readonly fxDirty: boolean;
  readonly spineDirty: boolean;
}

export interface CanvasPatchRuntime<TWireGraph = unknown> {
  readonly snapshot: DrawnSceneSnapshot<TWireGraph> | null;
  readonly stats: CanvasPatchStats;
  /** Revision of the last atomically presented frame; -1 before the first build. */
  revisionAtFrame(): number;
  resetChains(): void;
  noteAnimationPatch(input: { quads: number; nodes: number; transform?: { roots: number; commands: number; records: number; hits: number } }): void;
  /** Animation patches require the streamed scene itself to still be current. */
  admitAnimation(state: MirrorState): DrawnSceneSnapshot<TWireGraph> | null;
  /** The complete list-patch policy, evaluated before planning. */
  admitAnimationFrame(input: AnimationPatchAdmission): PatchBailReason | null;
  /** Wire patches intentionally advance the streamed revision, but not build inputs/resources. */
  admitWire(): DrawnSceneSnapshot<TWireGraph> | null;
  /** Exact no-op-wire admission and synchronous presentation. */
  tryUnchangedWireNoop(input: UnchangedWireNoopInput<TWireGraph>): boolean;
  /** The sole publication operation after a fully validated in-place mutation. */
  /** Publish an admitted patch with its exact streamed-node delta. */
  publish(next: MirrorState, changedIds?: Iterable<string>): DrawnSceneSnapshot<TWireGraph> | null;
}

/** Counters belong to the patch lifetime, not to the composer that supplies its ports. */
export interface CanvasPatchStats {
  readonly patchChain: number;
  readonly patchChainMax: number;
  readonly patchedFrames: number;
  readonly patchedQuads: number;
  readonly patchedNodes: number;
  readonly transformChain: number;
  readonly transformChainMax: number;
  readonly transformFrames: number;
  readonly transformRoots: number;
  readonly transformCommands: number;
  readonly transformRecords: number;
  readonly transformHits: number;
}

/** Renderer-owned channels which make an otherwise empty wire drain non-empty. */
export interface UnchangedWireNoopInput<_TWireGraph = unknown> {
  readonly state: MirrorState;
  readonly structural: boolean;
  readonly changedIds: number;
  readonly hasBuild: boolean;
  readonly hasOrder: boolean;
  readonly contextLost: boolean;
  readonly transformOverrides: boolean;
  readonly alphaOverrides: boolean;
  readonly cosmeticOffsets: boolean;
  readonly localAnimations: boolean;
  readonly frameSubstitutes: boolean;
  readonly offsetPending: boolean;
  readonly cosmeticCurrent: number;
  readonly cosmeticAtBuild: number;
  readonly trailLatchCurrent: number;
  readonly trailLatchAtBuild: number;
  readonly textureCurrent: string;
  readonly textureAtFrame: string;
  readonly fxDirty: boolean;
  readonly spineDirty: boolean;
  readonly trailDue: boolean;
  /** Paint remains in the runtime boundary so a successful no-op is a presentation. */
  readonly present: () => void;
}

export interface CanvasPatchRuntimePorts<TWireGraph = unknown> {
  readonly frame: CanvasFrameRuntime<TWireGraph>;
  readonly inputEpoch: () => number;
  readonly textureReadyEpoch: () => string;
  /** Bind backend-derived sidecars to the exact atomically published frame. */
  readonly onPublished?: (
    previous: DrawnSceneSnapshot<TWireGraph> | null,
    snapshot: DrawnSceneSnapshot<TWireGraph>,
  ) => void;
}

export function createCanvasPatchRuntime<TWireGraph>(ports: CanvasPatchRuntimePorts<TWireGraph>): CanvasPatchRuntime<TWireGraph> {
  let patchChain = 0;
  let patchChainMax = 0;
  let patchedFrames = 0;
  let patchedQuads = 0;
  let patchedNodes = 0;
  let transformChain = 0;
  let transformChainMax = 0;
  let transformFrames = 0;
  let transformRoots = 0;
  let transformCommands = 0;
  let transformRecords = 0;
  let transformHits = 0;
  // Diagnostics read this frequently, including more than once during one
  // admission. Keep one live view rather than allocating a snapshot object
  // for every getter access.
  const stats: CanvasPatchStats = {
    get patchChain() { return patchChain; },
    get patchChainMax() { return patchChainMax; },
    get patchedFrames() { return patchedFrames; },
    get patchedQuads() { return patchedQuads; },
    get patchedNodes() { return patchedNodes; },
    get transformChain() { return transformChain; },
    get transformChainMax() { return transformChainMax; },
    get transformFrames() { return transformFrames; },
    get transformRoots() { return transformRoots; },
    get transformCommands() { return transformCommands; },
    get transformRecords() { return transformRecords; },
    get transformHits() { return transformHits; },
  };
  function current(): DrawnSceneSnapshot<TWireGraph> | null {
    const snapshot = ports.frame.snapshot;
    if (snapshot === null || !ports.frame.listMatchesSnapshot) return null;
    return snapshot.inputEpoch === ports.inputEpoch()
      && snapshot.textureReadyEpoch === ports.textureReadyEpoch()
      ? snapshot
      : null;
  }

  function publish(next: MirrorState, changedIds?: Iterable<string>): DrawnSceneSnapshot<TWireGraph> | null {
    const previous = ports.frame.snapshot;
    const snapshot = ports.frame.publishPatch(next, changedIds);
    if (snapshot !== null) ports.onPublished?.(previous, snapshot);
    return snapshot;
  }

  return {
    get snapshot() { return ports.frame.snapshot; },
    get stats() { return stats; },
    revisionAtFrame: () => ports.frame.snapshot?.stateRevision ?? -1,
    resetChains() { patchChain = 0; transformChain = 0; },
    noteAnimationPatch(input) {
      patchedFrames++;
      patchedQuads += input.quads;
      patchedNodes += input.nodes;
      patchChain++;
      if (patchChain > patchChainMax) patchChainMax = patchChain;
      if (input.transform !== undefined) {
        transformFrames++;
        transformRoots += input.transform.roots;
        transformCommands += input.transform.commands;
        transformRecords += input.transform.records;
        transformHits += input.transform.hits;
        transformChain++;
        if (transformChain > transformChainMax) transformChainMax = transformChain;
      }
    },
    admitAnimation(state) {
      const snapshot = current();
      return snapshot !== null && snapshot.stateRevision === state.revision ? snapshot : null;
    },
    admitAnimationFrame(input) {
      if (input.state === null || !input.hasBuild || !input.hasOrder) return "noBuild";
      if (input.contextLost) return "contextLost";
      if (input.patchChain >= PATCH_CHAIN_MAX) return "chain";
      if (input.sampleMask === input.noSampleMask || (!input.opacitySamples && !input.animRoots && !input.sourceSamples)) return "noSamples";
      if (current() === null || ports.frame.snapshot?.stateRevision !== input.state.revision) return "staleState";
      if (input.transformSamples) return "transform";
      if (input.hasUnknownAnim) return "unknownAnim";
      if (input.animRoots && input.transformChain >= PATCH_TRANSFORM_CHAIN_MAX) return "chain";
      if (input.offsetPending) return "offsetPending";
      if (input.cosmeticCurrent !== input.cosmeticAtBuild) return "cosmetic";
      if (input.trailLatchCurrent !== input.trailLatchAtBuild) return "trailLatch";
      if (input.trailDue) return "trails";
      if (input.fxDirty) return "fx";
      if (input.spineDirty) return "spine";
      return null;
    },
    admitWire: current,
    tryUnchangedWireNoop(input) {
      if (
        input.structural || input.changedIds !== 0 || !input.hasBuild || !input.hasOrder || input.contextLost ||
        input.transformOverrides || input.alphaOverrides || input.cosmeticOffsets || input.localAnimations ||
        input.frameSubstitutes || input.offsetPending || input.cosmeticCurrent !== input.cosmeticAtBuild ||
        input.trailLatchCurrent !== input.trailLatchAtBuild || current() === null ||
        input.textureCurrent !== input.textureAtFrame || input.fxDirty || input.spineDirty || input.trailDue
      ) return false;
      if (publish(input.state, NO_CHANGED_IDS) === null) return false;
      input.present();
      return true;
    },
    publish,
  };
}

/** The composer-facing source result; the runtime never guesses atlas residency. */
export interface CanvasPatchResolvedSource {
  readonly texture: ExecutorTexture | null;
  readonly srcX: number;
  readonly srcY: number;
  readonly srcW: number;
  readonly srcH: number;
}

/** Counters and reusable planning memory owned by one patch-execution lifetime. */
export interface CanvasPatchExecutionStats {
  readonly patchBailouts: Record<PatchBailReason, number>;
  readonly sourcePatchedFrames: number;
  readonly sourcePatchedQuads: number;
  readonly sourcePatchedNodes: number;
  readonly idlePatched: number;
  readonly wireBuildCauses: Record<WireDeltaBuildCause, number>;
  readonly wireDirectPatches: number;
  readonly wireNodesVisited: number;
  readonly wireChangedCommands: number;
  readonly wireSourcePatches: number;
}

/**
 * The patch execution runtime owns list mutation, planning and synchronous
 * presentation. The composer owns the backend resources themselves, exposing
 * only the facts and narrow operations the patcher needs to consume them.
 * None of these callbacks acknowledges a scene.
 */
export interface CanvasPatchExecutionPorts {
  readonly patch: CanvasPatchRuntime<WireDeltaGraph>;
  readonly frame: CanvasFrameRuntime<WireDeltaGraph>;
  readonly state: () => MirrorState | null;
  readonly list: DrawList<ExecutorTexture | null>;
  readonly now: () => number;
  readonly contextLost: () => boolean;
  readonly textureReadyEpoch: () => string;
  readonly fxDirty: () => boolean;
  readonly spineDirty: () => boolean;
  readonly trailDue: (at: number) => boolean;
  readonly transformOverrides: ReadonlyMap<string, unknown>;
  readonly alphaOverrides: ReadonlyMap<string, AlphaOverride>;
  readonly alphaApplied: ReadonlyMap<string, AlphaOverride>;
  readonly cosmeticOffsets: ReadonlyMap<string, unknown>;
  readonly localAnims: ReadonlyMap<string, LocalAnim>;
  readonly frameSubstitutes: ReadonlyMap<string, MirrorNode>;
  readonly opacitySampledIds: ReadonlySet<string>;
  readonly sourceSampledIds: ReadonlySet<string>;
  readonly frameSampleMask: () => number;
  readonly intentNode: (id: string) => MirrorNode | undefined;
  readonly offsetPending: () => boolean;
  readonly cosmeticVersion: () => number;
  readonly cosmeticVersionAtBuild: () => number;
  readonly trailLatchVersion: () => number;
  readonly trailLatchVersionAtBuild: () => number;
  readonly spreadDxOf: (id: string) => number;
  readonly resolveSource: (node: MirrorNode | undefined) => CanvasPatchResolvedSource;
  readonly bankAppliedAlphas: () => void;
  readonly invalidateInputCaches: () => void;
  readonly notePatchTiming: (elapsedMs: number) => void;
  readonly syncOverlay: (state: MirrorState) => void;
  /** Synchronous direct paint only; this is deliberately not an acknowledgement callback. */
  readonly present: () => void;
}

export interface CanvasPatchExecutionRuntime {
  readonly stats: CanvasPatchExecutionStats;
  tryUnchangedWireNoop(next: MirrorState, structural: boolean, at: number): boolean;
  tryWireDeltaPatch(next: MirrorState, structural: boolean, at: number): boolean;
  tryPatchAndPaint(at: number): boolean;
}

const INVALID_WIRE_SOURCE_RANGE = Object.freeze({ start: -1, paintEnd: -2 });
const NO_CHILDREN: readonly string[] = [];
const NO_ANIM_FRAMES: ReadonlyMap<string, PatchAnimFrame> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The complete patch executor. Every planner fills runtime-owned scratch
 * first; no mutation, frame publication or presentation happens until all
 * later admission work has accepted the candidate.
 */
export function createCanvasPatchExecutionRuntime(ports: CanvasPatchExecutionPorts): CanvasPatchExecutionRuntime {
  const wireDeltaScratch = createWireDeltaScratch();
  const patchViews = createPaintScratch(1);
  const patchScratch = createPatchScratch(patchViews.quad, patchViews.nine);
  const wireChangedCommandIndexes = new Set<number>();
  const wireAppliedAlphas = new Map<string, WireNodeSnapshot>();
  const patchOutcome: PatchOutcome = { patched: false, bail: null, quads: 0, nodes: 0, visited: 0 };
  const sourceOutcome: PatchOutcome = { patched: false, bail: null, quads: 0, nodes: 0, visited: 0 };
  const sourcePatches: SourcePatch<ExecutorTexture>[] = [];
  const wireSourcePatchRecords: SourcePatch<ExecutorTexture>[] = [];
  const transformViews = createPaintScratch(1);
  const transformScratch = createTransformScratch(transformViews.quad, transformViews.nine, transformViews.glyphs);
  const transformOutcome: TransformOutcome = {
    ok: false,
    bail: null,
    roots: 0,
    commands: 0,
    records: 0,
    hits: 0,
    visited: 0,
  };
  const stats: {
    patchBailouts: Record<PatchBailReason, number>;
    sourcePatchedFrames: number;
    sourcePatchedQuads: number;
    sourcePatchedNodes: number;
    idlePatched: number;
    wireBuildCauses: Record<WireDeltaBuildCause, number>;
    wireDirectPatches: number;
    wireNodesVisited: number;
    wireChangedCommands: number;
    wireSourcePatches: number;
  } = {
    patchBailouts: Object.fromEntries(PATCH_BAIL_REASONS.map((reason) => [reason, 0])) as Record<PatchBailReason, number>,
    sourcePatchedFrames: 0,
    sourcePatchedQuads: 0,
    sourcePatchedNodes: 0,
    idlePatched: 0,
    wireBuildCauses: { cold: 0, structural: 0, broad: 0, unknown: 0, transform: 0, content: 0 },
    wireDirectPatches: 0,
    wireNodesVisited: 0,
    wireChangedCommands: 0,
    wireSourcePatches: 0,
  };

  const patchEnv: PatchEnv = {
    nodeOf: (id) => ports.state()?.nodes.get(id),
    childrenOf: (id) => ports.frame.snapshot?.paintOrder.childrenOf(id) ?? NO_CHILDREN,
    rangeOf: (id) => ports.frame.snapshot?.build.ranges.get(id),
    appliedAlphaOf: (id) => wireAppliedAlphas.get(id) ?? ports.alphaApplied.get(id),
    currentAlphaOf: (id) => ports.alphaOverrides.get(id),
  };
  const transformEnv: TransformPatchEnv = {
    get orderIds() {
      return ports.frame.snapshot?.paintOrder.ids ?? NO_CHILDREN;
    },
    spanOf: (id) => ports.frame.snapshot?.paintOrder.entries.get(id),
    get animFrames() {
      return (ports.frame.snapshot?.build.localAnimFrames as ReadonlyMap<string, PatchAnimFrame> | undefined) ?? NO_ANIM_FRAMES;
    },
    animNowOf: (id) => ports.localAnims.get(id) ?? null,
    rangeOf: (id) => ports.frame.snapshot?.build.ranges.get(id),
    isViewScaleCandidate: (id) => (ports.frame.snapshot?.build.viewScaleCandidates ?? NO_IDS).has(id),
    isOverlayClipped: (id) => (ports.frame.snapshot?.build.overlayClipped ?? NO_IDS).has(id),
    isClipper: (id) => ports.frame.snapshot?.build.clipRanges.has(id) ?? false,
    hasCosmeticOffset: (id) => ports.cosmeticOffsets.has(id),
    isCaptured: (id) => ports.frame.snapshot?.capturedGlobals.has(id) ?? false,
    hasTransformOverride: (id) => ports.transformOverrides.has(id),
    hasTrailQuad: (id) => (ports.frame.snapshot?.build.trailQuadIds ?? NO_IDS).has(id),
    isTextDrawn: (id) => (ports.frame.snapshot?.build.textQuadIds ?? NO_IDS).has(id),
    spreadDxOf: ports.spreadDxOf,
    get backstopOrder() {
      return ports.frame.snapshot?.build.backstopOrder ?? -1;
    },
  };

  function textureEpochAtFrame(): string {
    return ports.frame.snapshot?.textureReadyEpoch ?? "";
  }

  // `admitAnimationFrame` deliberately evaluates these in its policy order.
  // Keep the object for the runtime lifetime and expose facts as getters: a
  // no-build/context/chain refusal must not scan local animations, sample a
  // source mask, or query effect/spine/trail state first.
  let animationAt = 0;
  let animationState: MirrorState | null = null;
  const animationAdmission: AnimationPatchAdmission = {
    get state() { return animationState; },
    get hasBuild() { return ports.frame.snapshot?.build !== undefined; },
    get hasOrder() { return ports.frame.snapshot?.paintOrder !== undefined; },
    get contextLost() { return ports.contextLost(); },
    get patchChain() { return ports.patch.stats.patchChain; },
    get transformChain() { return ports.patch.stats.transformChain; },
    get sampleMask() { return ports.frameSampleMask(); },
    get noSampleMask() { return SAMPLE_NONE; },
    get opacitySamples() { return ports.opacitySampledIds.size; },
    get animRoots() {
      const build = ports.frame.snapshot?.build;
      return build !== undefined && (build.localAnimFrames.size > 0 || ports.localAnims.size > 0);
    },
    get sourceSamples() { return (ports.frameSampleMask() & SAMPLE_SOURCE) !== 0; },
    get transformSamples() { return (ports.frameSampleMask() & SAMPLE_TRANSFORM) !== 0; },
    get hasUnknownAnim() {
      const build = ports.frame.snapshot?.build;
      if (build === undefined) return false;
      for (const id of ports.localAnims.keys()) {
        if (!build.localAnimFrames.has(id)) return true;
      }
      return false;
    },
    get offsetPending() { return ports.offsetPending(); },
    get cosmeticCurrent() { return ports.cosmeticVersion(); },
    get cosmeticAtBuild() { return ports.cosmeticVersionAtBuild(); },
    get trailLatchCurrent() { return ports.trailLatchVersion(); },
    get trailLatchAtBuild() { return ports.trailLatchVersionAtBuild(); },
    get trailDue() { return ports.trailDue(animationAt); },
    get fxDirty() { return ports.fxDirty(); },
    get spineDirty() { return ports.spineDirty(); },
  };

  function framePatchBail(at: number, state: MirrorState): PatchBailReason | null {
    animationAt = at;
    animationState = state;
    return ports.patch.admitAnimationFrame(animationAdmission);
  }

  // The no-op wire gate follows the same left-to-right admission policy as
  // the former composer path. These stable lazy facts keep structural/changed
  // drains from touching texture, effect, spine or trail probes.
  let unchangedWireState: MirrorState | null = null;
  let unchangedWireStructural = false;
  let unchangedWireAt = 0;
  const unchangedWireAdmission: UnchangedWireNoopInput<WireDeltaGraph> = {
    get state() { return unchangedWireState!; },
    get structural() { return unchangedWireStructural; },
    get changedIds() { return unchangedWireState!.changedIds.size; },
    get hasBuild() { return ports.frame.snapshot?.build !== undefined; },
    get hasOrder() { return ports.frame.snapshot?.paintOrder !== undefined; },
    get contextLost() { return ports.contextLost(); },
    get transformOverrides() { return ports.transformOverrides.size !== 0; },
    get alphaOverrides() { return ports.alphaOverrides.size !== 0; },
    get cosmeticOffsets() { return ports.cosmeticOffsets.size !== 0; },
    get localAnimations() { return ports.localAnims.size !== 0; },
    get frameSubstitutes() { return ports.frameSubstitutes.size !== 0; },
    get offsetPending() { return ports.offsetPending(); },
    get cosmeticCurrent() { return ports.cosmeticVersion(); },
    get cosmeticAtBuild() { return ports.cosmeticVersionAtBuild(); },
    get trailLatchCurrent() { return ports.trailLatchVersion(); },
    get trailLatchAtBuild() { return ports.trailLatchVersionAtBuild(); },
    get textureCurrent() { return ports.textureReadyEpoch(); },
    get textureAtFrame() { return textureEpochAtFrame(); },
    get fxDirty() { return ports.fxDirty(); },
    get spineDirty() { return ports.spineDirty(); },
    get trailDue() { return ports.trailDue(unchangedWireAt); },
    present: ports.present,
  };

  function tryUnchangedWireNoop(next: MirrorState, structural: boolean, at: number): boolean {
    unchangedWireState = next;
    unchangedWireStructural = structural;
    unchangedWireAt = at;
    return ports.patch.tryUnchangedWireNoop(unchangedWireAdmission);
  }

  function tryWireDeltaPatch(next: MirrorState, structural: boolean, at: number): boolean {
    const snapshot = ports.frame.snapshot;
    const graph = snapshot?.derived.wireGraph ?? null;
    const plan = planWireDelta(graph, next, next.changedIds, structural, wireDeltaScratch);
    stats.wireNodesVisited += plan.nodesVisited;
    if (plan.mode === "full") {
      stats.wireBuildCauses[plan.cause ?? "broad"]++;
      return false;
    }
    const build = snapshot?.build ?? null;
    const order = snapshot?.paintOrder ?? null;
    // Builder-owned channels must be stable before the direct list path can
    // make this wire revision current.
    if (
      build === null || order === null || ports.contextLost() || ports.patch.admitWire() === null ||
      ports.transformOverrides.size > 0 || ports.alphaOverrides.size > 0 ||
      ports.cosmeticOffsets.size > 0 || ports.localAnims.size > 0 || ports.frameSubstitutes.size > 0 ||
      ports.offsetPending() || ports.cosmeticVersion() !== ports.cosmeticVersionAtBuild() ||
      ports.trailLatchVersion() !== ports.trailLatchVersionAtBuild() || textureEpochAtFrame() !== ports.textureReadyEpoch() ||
      ports.fxDirty() || ports.spineDirty() || ports.trailDue(at)
    ) {
      stats.wireBuildCauses.broad++;
      return false;
    }

    patchOutcome.patched = false;
    patchOutcome.bail = null;
    patchOutcome.quads = 0;
    patchOutcome.nodes = 0;
    patchOutcome.visited = 0;
    sourceOutcome.patched = false;
    sourceOutcome.bail = null;
    sourceOutcome.quads = 0;
    sourceOutcome.nodes = 0;
    sourceOutcome.visited = 0;
    patchScratch.planned = 0;
    patchScratch.sourcePlanned = 0;
    if (plan.transformIds.length > 0) {
      stats.wireBuildCauses.transform++;
      return false;
    }

    let wireSourceCount = 0;
    for (const id of plan.sourceIds) {
      const node = next.nodes.get(id);
      const range = graph!.nodes.get(id)?.range ?? null;
      const resolved = ports.resolveSource(node);
      const source = wireSourcePatchRecords[wireSourceCount] ?? (wireSourcePatchRecords[wireSourceCount] = {
        id: "",
        range: INVALID_WIRE_SOURCE_RANGE,
        texture: null,
        srcX: Number.NaN,
        srcY: Number.NaN,
        srcW: Number.NaN,
        srcH: Number.NaN,
      });
      source.id = id;
      source.range = range ?? INVALID_WIRE_SOURCE_RANGE;
      source.texture = resolved.texture;
      source.srcX = resolved.srcX;
      source.srcY = resolved.srcY;
      source.srcW = resolved.srcW;
      source.srcH = resolved.srcH;
      wireSourceCount++;
    }
    wireSourcePatchRecords.length = wireSourceCount;
    if (plan.sourceIds.length > 0) {
      planSource(wireSourcePatchRecords, ports.list as SourcePatchTarget<ExecutorTexture>, patchScratch, sourceOutcome);
      if (!sourceOutcome.patched) {
        stats.wireBuildCauses.content++;
        return false;
      }
    }

    wireAppliedAlphas.clear();
    for (const id of plan.opacityIds) wireAppliedAlphas.set(id, graph!.nodes.get(id)!);
    if (plan.opacityIds.length > 0) {
      planOpacity(plan.opacityRoots, patchEnv, ports.list, patchScratch, patchOutcome);
      if (!patchOutcome.patched) {
        wireAppliedAlphas.clear();
        stats.wireBuildCauses.content++;
        return false;
      }
    }

    // Source and opacity plans can both write a quad. Count that command once.
    wireChangedCommandIndexes.clear();
    for (let index = 0; index < patchScratch.sourcePlanned; index++) {
      wireChangedCommandIndexes.add(patchScratch.sourceIndexes[index]);
    }
    for (let range = 0; range < patchScratch.planned; range++) {
      for (let index = patchScratch.starts[range]; index < patchScratch.ends[range]; index++) {
        wireChangedCommandIndexes.add(index);
      }
    }

    if (plan.opacityIds.length > 0) applyOpacityPlan(ports.list, patchScratch, patchOutcome);
    if (plan.sourceIds.length > 0) applySourcePlan(ports.list as SourcePatchTarget<ExecutorTexture>, patchScratch, sourceOutcome);
    wireAppliedAlphas.clear();
    commitWireDelta(graph!, next, plan.changedIds, wireDeltaScratch);
    if (ports.patch.publish(next, plan.changedIds) === null) return false;
    stats.wireDirectPatches++;
    stats.wireChangedCommands += wireChangedCommandIndexes.size;
    stats.wireSourcePatches += sourceOutcome.quads;
    ports.syncOverlay(next);
    ports.present();
    return true;
  }

  function tryPatchAndPaint(at: number): boolean {
    const state = ports.state();
    if (state === null) return false;
    const frameBail = framePatchBail(at, state);
    if (frameBail !== null) {
      stats.patchBailouts[frameBail]++;
      return false;
    }
    const snapshot = ports.frame.snapshot!;
    const build = snapshot.build;
    const t0 = ports.now();
    // Plan the transform arm before any later arm can write. A refusal leaves
    // the list exactly as the preceding frame published it.
    const planning = build.localAnimFrames.size > 0 || ports.localAnims.size > 0;
    if (planning) {
      planTransform(transformEnv, ports.list, transformScratch, transformOutcome);
      if (!transformOutcome.ok) {
        stats.patchBailouts[transformOutcome.bail ?? "unknownAnim"]++;
        return false;
      }
    }
    const sourceSampled = (ports.frameSampleMask() & SAMPLE_SOURCE) !== 0;
    if (sourceSampled) {
      if (typeof ports.list.patchQuadSource !== "function") {
        stats.patchBailouts.source++;
        return false;
      }
      sourcePatches.length = 0;
      for (const id of ports.sourceSampledIds) {
        const resolved = ports.resolveSource(ports.frameSubstitutes.get(id) ?? ports.intentNode(id));
        sourcePatches.push({
          id,
          range: build.ranges.get(id) ?? INVALID_WIRE_SOURCE_RANGE,
          texture: resolved.texture,
          srcX: resolved.srcX,
          srcY: resolved.srcY,
          srcW: resolved.srcW,
          srcH: resolved.srcH,
        });
      }
      planSource(sourcePatches, ports.list as SourcePatchTarget<ExecutorTexture>, patchScratch, sourceOutcome);
      if (!sourceOutcome.patched) {
        stats.patchBailouts[sourceOutcome.bail ?? "source"]++;
        return false;
      }
    }

    patchOpacity(ports.opacitySampledIds, patchEnv, ports.list, patchScratch, patchOutcome);
    if (!patchOutcome.patched) {
      stats.patchBailouts[patchOutcome.bail ?? "noBuild"]++;
      return false;
    }
    if (sourceSampled) {
      applySourcePlan(ports.list as SourcePatchTarget<ExecutorTexture>, patchScratch, sourceOutcome);
      stats.sourcePatchedFrames++;
      stats.sourcePatchedQuads += sourceOutcome.quads;
      stats.sourcePatchedNodes += sourceOutcome.nodes;
    }
    if (planning && transformScratch.planned > 0) {
      applyTransformPlan(transformEnv, ports.list, build.overlayRecords, snapshot.hitEntries, transformScratch, transformOutcome);
      ports.invalidateInputCaches();
      if (ports.localAnims.size > 0) stats.idlePatched++;
    }
    ports.bankAppliedAlphas();
    if (ports.patch.publish(state) === null) return false;
    ports.patch.noteAnimationPatch({
      quads: patchOutcome.quads,
      nodes: patchOutcome.nodes,
      transform: planning && transformScratch.planned > 0
        ? {
            roots: transformOutcome.roots,
            commands: transformOutcome.commands,
            records: transformOutcome.records,
            hits: transformOutcome.hits,
          }
        : undefined,
    });
    ports.notePatchTiming(ports.now() - t0);
    ports.syncOverlay(state);
    ports.present();
    return true;
  }

  return {
    stats,
    tryUnchangedWireNoop,
    tryWireDeltaPatch,
    tryPatchAndPaint,
  };
}
