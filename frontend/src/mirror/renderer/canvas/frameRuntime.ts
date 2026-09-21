/**
 * The canvas frame boundary.
 *
 * This is deliberately the only owner of a completed draw-list snapshot.  A
 * build has several products (commands, painter order, hit targets and global
 * matrices); publishing them separately made it too easy for patch/input code
 * to observe an old hit list with a new command stream.  `publish` changes the
 * one reference only after every product has been built and strict-canvas
 * admission has accepted it.
 */
import {
  type CanvasExecutor,
  type CompiledDrawList,
  type DrawList,
  type ExecutorTexture,
  type StageProjection,
} from "@godot-scene-web/canvas";

import { buildDrawList, type CapturedGlobal, type DrawListBuild } from "@/mirror/canvas/buildDrawList";
import { type HitEntry } from "@/mirror/canvas/hitTest";
import { type PaintOrder } from "@/mirror/canvas/paintOrder";
import { type PaintGuard } from "@/mirror/canvas/paintGuard";
import { type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

/** Fixed canvas cadence for locally retained idle and intent animation. */
export const CANVAS_IDLE_ANIMATION_FPS = 30;

/**
 * The retained scene facts that produced a drawn frame.
 *
 * `MirrorState.nodes` is deliberately mutated in place by later wire deltas.
 * A frame consumer must therefore never read that live map beside an older
 * draw list after strict admission has declined a candidate. Node records are
 * replacement values, so a full build can take a shallow map copy without
 * duplicating every node payload. That retained map is advanced only by a
 * later admitted direct patch.
 */
export interface DrawnSceneState {
  readonly nodes: ReadonlyMap<string, MirrorNode>;
  readonly orderedIds: readonly string[];
}

export interface FrameDerivedData<TWireGraph = unknown> {
  readonly wireGraph: TWireGraph;
  readonly wireHitsByNode: ReadonlyMap<string, readonly HitEntry[]>;
  readonly wireOverlayOrders: ReadonlySet<number>;
}

export interface DrawnSceneSnapshot<TWireGraph = unknown> {
  /** The retained scene graph from the same atomically published frame as every product below. */
  readonly scene: DrawnSceneState;
  readonly build: DrawListBuild;
  readonly paintOrder: PaintOrder;
  readonly hitEntries: readonly HitEntry[];
  readonly capturedGlobals: ReadonlyMap<string, CapturedGlobal>;
  /** Monotonic identity for input and patch caches. */
  readonly buildEpoch: number;
  readonly stateRevision: number;
  readonly inputEpoch: number;
  readonly resourceEpoch: number;
  /** Texture readiness identity used by patch admission for this build. */
  readonly textureReadyEpoch: string;
  /** Data derived from this exact build, never from a later mutable walk. */
  readonly derived: FrameDerivedData<TWireGraph>;
}

export interface CanvasFrameRuntime<TWireGraph = unknown> {
  readonly snapshot: DrawnSceneSnapshot<TWireGraph> | null;
  /** Whether the mutable draw-list arena still represents {@link snapshot}. */
  readonly listMatchesSnapshot: boolean;
  readonly builds: number;
  runBuild(next: MirrorState): boolean;
  /**
   * Publish a successful in-place list mutation.  The caller must complete
   * every validation before mutating the draw list, hits, or derived graph;
   * this is the one post-mutation publication point.
   */
  /**
   * Publish an already-admitted in-place draw-list mutation. `changedIds` is
   * the exact small wire set the patch planner admitted; animation patches
   * omit it and reuse the scene captured by the previous snapshot.
   */
  publishPatch(next: MirrorState, changedIds?: Iterable<string>): DrawnSceneSnapshot<TWireGraph> | null;
  paint(options?: CanvasPaintOptions): void;
  invalidatePaintGuard(): void;
  dispose(): void;
}

export interface CanvasPaintOptions {
  force?: boolean;
  clearColor?: readonly [number, number, number, number];
  compiled?: CompiledDrawList<ExecutorTexture | null>;
}

export type CanvasLocalRebuildCause =
  | "anim"
  | "texture"
  | "restore"
  | "offset"
  | "snapshot"
  | "uiScaling"
  | "chrome";

type PresentationFramePorts<TWireGraph> = Omit<
  CanvasFrameRuntimePorts<TWireGraph>,
  | "pixelEpoch"
  | "onPaintTiming"
  | "beforeDirectPaint"
  | "onPaintUnavailable"
  | "onPaintSkipped"
  | "onPainted"
>;

/**
 * Frame-local presentation state layered over the immutable snapshot engine.
 *
 * The root wires resource/input domains into `framePorts`, but this runtime
 * owns the direct-paint accounting, mutable pixel epoch, full local rebuild
 * transaction and snapshot-safe chrome patch boundary. It intentionally knows
 * nothing about interaction or effect implementations.
 */
export interface CanvasFramePresentationOptions<TWireGraph> {
  readonly framePorts: PresentationFramePorts<TWireGraph>;
  /** Pixel revisions visible to every list consumer before local force ticks. */
  readonly basePixelEpoch: () => number;
  readonly compiled?: CompiledDrawList<ExecutorTexture | null>;
  readonly clearColor?: readonly [number, number, number, number];
  readonly state: () => MirrorState | null;
  readonly disposed: () => boolean;
  /** Overlay synchronization is synchronous and follows a successful build. */
  readonly syncOverlay: (state: MirrorState) => void;
  /** Called at the actual direct executor submission boundary. */
  readonly beforeDirectPaint: () => void;
  readonly onDirectPaintTiming: (elapsedMs: number) => void;
  readonly onPaintUnavailable: () => void;
  readonly onPaintSkipped: () => void;
  readonly onPainted?: (drew: boolean) => void;
}

export interface CanvasFramePresentationRuntime<TWireGraph> {
  readonly frame: CanvasFrameRuntime<TWireGraph>;
  readonly paintedFrames: number;
  readonly skippedPaints: number;
  readonly pixelForce: number;
  runBuild(next: MirrorState): boolean;
  /** A local pixel readiness event; it never acknowledges a scene delta. */
  notePixelsChanged(): void;
  invalidatePaintGuard(): void;
  paint(force?: boolean): void;
  /** Full build → overlay synchronization → synchronous direct presentation. */
  buildAndPaint(
    state: MirrorState,
    options?: CanvasFramePresentationBuildOptions,
  ): boolean;
  /** Full build → overlay sync → synchronous presentation, without a scene ack. */
  rebuildAndPaint(cause: CanvasLocalRebuildCause): boolean;
  /**
   * Mutate only a command belonging to the currently published snapshot, then
   * present it locally. The callback receives the exact successful build.
   */
  patchChrome(patch: (build: DrawListBuild) => boolean): boolean;
  dispose(): void;
}

export interface CanvasFramePresentationBuildOptions {
  /** The image-capture seam needs a submit even when the bank is unchanged. */
  readonly force?: boolean;
}

export interface CanvasFrameRuntimePorts<TWireGraph = unknown> {
  readonly list: DrawList<ExecutorTexture | null>;
  /** String-facing bridge view over `list`; the scene builder owns URL handles. */
  readonly buildList: DrawList<string>;
  readonly executor: Pick<CanvasExecutor, "execute">;
  readonly projection: () => StageProjection;
  readonly paintGuard: PaintGuard<ExecutorTexture | null>;
  readonly paintSkipEnabled: boolean;
  readonly isUnavailable: () => boolean;
  readonly pixelEpoch: () => number;
  readonly inputEpoch: () => number;
  readonly textureReadyEpoch: () => string;
  readonly now: () => number;
  readonly buildScene: typeof buildDrawList;
  readonly makeBuildOptions: (
    next: MirrorState,
    capturedGlobals: Map<string, CapturedGlobal>,
    captureIds: ReadonlySet<string>,
  ) => Parameters<typeof buildDrawList>[2];
  /**
   * Prepare backend state for a candidate. This must not mutate data exposed by
   * the current snapshot: strict admission can reject the candidate.
   */
  readonly prepareBuild: (next: MirrorState) => void;
  /** Fill the runtime-owned capture set for this candidate build. */
  readonly collectCaptureIds: (out: Set<string>) => void;
  /** Emit backend-owned prefix commands after the list reset. */
  readonly emitBuildPrefix: (list: DrawList<string>) => void;
  /** Returns false for a pending strict source before anything can present. */
  readonly admitBuild: (build: DrawListBuild) => boolean;
  /** Finalize text/pixel/effect owners after a successfully admitted build. */
  readonly finalizeBuild: (state: MirrorState, build: DrawListBuild) => void;
  /** Finish backend-only derived state while the candidate is still private. */
  readonly finalizeDerived: (state: MirrorState, snapshot: DrawnSceneSnapshot<TWireGraph>) => void;
  /** Capture the retained wire graph while the just-built ranges are exact. */
  readonly captureWireGraph: (state: MirrorState, build: DrawListBuild) => TWireGraph;
  readonly onBuildTiming: (elapsedMs: number) => void;
  readonly onPaintTiming: (elapsedMs: number) => void;
  /** Called immediately before direct executor submission. */
  readonly beforeDirectPaint: () => void;
  /** Clear per-presentation state when a lost/disposed stage cannot submit. */
  readonly onPaintUnavailable: () => void;
  readonly onPaintSkipped: () => void;
  readonly onPainted: (drew: boolean) => void;
}

/**
 * Owns full build execution and direct presentation. In-place patches consume
 * this runtime's snapshot rather than carrying a second mutable build/order/hit tuple.
 */
export function createCanvasFrameRuntime<TWireGraph>(ports: CanvasFrameRuntimePorts<TWireGraph>): CanvasFrameRuntime<TWireGraph> {
  let snapshot: DrawnSceneSnapshot<TWireGraph> | null = null;
  // A strict candidate resets the one shared command arena before its source
  // admission is known. Keep the old snapshot observable for input, but never
  // let a patch or diagnostic claim that the reset arena still describes it.
  let listMatchesSnapshot = false;
  let builds = 0;
  // A capture map is part of a drawn frame.  Reusing a single map made the
  // next *rejected* build erase globals still read by interaction/diagnostics.
  // Two maps are enough: the candidate always uses the map not published by
  // the current snapshot, and is rotated only at the publication point.
  const capturedGlobalBuffers = [new Map<string, CapturedGlobal>(), new Map<string, CapturedGlobal>()] as const;
  const captureIds = new Set<string>();

  function candidateGlobals(): Map<string, CapturedGlobal> {
    return snapshot?.capturedGlobals === capturedGlobalBuffers[0]
      ? capturedGlobalBuffers[1]
      : capturedGlobalBuffers[0];
  }

  function derivedFor(next: MirrorState, build: DrawListBuild): FrameDerivedData<TWireGraph> {
    const wireHitsByNode = new Map<string, HitEntry[]>();
    for (const hit of build.hitEntries) {
      let bucket = wireHitsByNode.get(hit.nodeId);
      if (bucket === undefined) {
        bucket = [];
        wireHitsByNode.set(hit.nodeId, bucket);
      }
      bucket.push(hit);
    }
    const wireOverlayOrders = new Set<number>();
    for (const record of build.overlayRecords) wireOverlayOrders.add(record.order);
    return {
      wireGraph: ports.captureWireGraph(next, build),
      wireHitsByNode,
      wireOverlayOrders,
    };
  }

  function sceneForFullBuild(next: MirrorState): DrawnSceneState {
    return {
      // `applySceneDelta` replaces changed node records rather than mutating
      // them. This makes the newly published frame independent of the live
      // map; a later admitted direct patch advances it by its exact delta.
      nodes: new Map(next.nodes),
      // Scene deltas replace this array on structural changes; they never
      // mutate it. Retaining the identity lets a direct wire patch prove its
      // topology is unchanged without copying a 3,000-node map.
      orderedIds: next.orderedIds,
    };
  }

  /**
   * A patch is admitted before this runs, so the currently published scene is
   * not observable in a half-updated state. Keeping that map is intentional:
   * historical snapshots are not public durable values, while cloning a
   * 3,000-node map for every direct wire edit would erase the hot path's
   * benefit. A full/structural candidate takes `sceneForFullBuild` instead.
   */
  function sceneForPatch(
    previous: DrawnSceneState,
    next: MirrorState,
    changedIds: Iterable<string> | undefined,
  ): DrawnSceneState {
    if (previous.orderedIds !== next.orderedIds) {
      return sceneForFullBuild(next);
    }
    // Animation patches keep the state revision above and never enter this
    // branch. A revision-changing caller without an exact delta must take the
    // conservative full copy rather than publish scene facts from an older
    // frame; production direct-wire paths always supply `changedIds`.
    if (changedIds === undefined) return sceneForFullBuild(next);
    // `nodes` is readonly to consumers, not immutable to this frame owner.
    // This only touches the planner-proven O(changedIds) delta after every
    // list and in-place patch admission has succeeded.
    const patchedNodes = previous.nodes as Map<string, MirrorNode>;
    for (const id of changedIds) {
      const node = next.nodes.get(id);
      if (node === undefined) patchedNodes.delete(id);
      else patchedNodes.set(id, node);
    }
    return previous;
  }

  function runBuild(next: MirrorState): boolean {
    const started = ports.now();
    // Diagnostics count attempted builds, matching the pre-split boundary;
    // snapshot epochs and timing remain success-only below.
    builds++;
    const globals = candidateGlobals();
    globals.clear();
    ports.prepareBuild(next);
    captureIds.clear();
    ports.collectCaptureIds(captureIds);
    // `buildList` is the shared mutable arena. From this reset through either
    // publication or refusal it cannot be paired with the preceding snapshot.
    listMatchesSnapshot = false;
    ports.buildList.reset();
    ports.emitBuildPrefix(ports.buildList);
    const build = ports.buildScene(next, ports.buildList, ports.makeBuildOptions(next, globals, captureIds));
    // Admission is intentionally before publication. A strict source can leave
    // a partial command list behind, but no consumer ever sees it as a frame.
    if (!ports.admitBuild(build)) return false;

    // Resource finalization can release a paced texture, so take the
    // readiness epoch only after it has completed. Nothing is public yet.
    ports.finalizeBuild(next, build);
    const nextSnapshot: DrawnSceneSnapshot<TWireGraph> = {
      scene: sceneForFullBuild(next),
      build,
      paintOrder: build.order,
      hitEntries: build.hitEntries,
      capturedGlobals: globals,
      buildEpoch: (snapshot?.buildEpoch ?? 0) + 1,
      stateRevision: next.revision,
      inputEpoch: ports.inputEpoch(),
      resourceEpoch: ports.pixelEpoch(),
      textureReadyEpoch: ports.textureReadyEpoch(),
      derived: derivedFor(next, build),
    };
    // The last synchronous derived work must complete before the one atomic
    // publication point; diagnostics/input may otherwise re-enter between an
    // exposed snapshot and caches that claim to describe it.
    ports.finalizeDerived(next, nextSnapshot);
    // Atomic publication point: every snapshot field comes from the same walk
    // and all synchronous resource/derived finalization has succeeded.
    snapshot = nextSnapshot;
    listMatchesSnapshot = true;
    ports.onBuildTiming(ports.now() - started);
    return true;
  }

  function paint(options: CanvasPaintOptions = {}): void {
    // A strict candidate reuses and resets this arena before it knows whether
    // its source is admissible. Never submit that candidate beside the last
    // published snapshot: callers must wait for a successfully published full
    // build to restore the pairing.
    if (!listMatchesSnapshot || ports.isUnavailable()) {
      ports.onPaintUnavailable();
      return;
    }
    const projection = ports.projection();
    const epoch = ports.pixelEpoch();
    if (!options.force && ports.paintSkipEnabled && ports.paintGuard.unchanged(ports.list, projection, epoch)) {
      ports.onPaintSkipped();
      return;
    }
    const started = ports.now();
    ports.beforeDirectPaint();
    const drew = ports.executor.execute(ports.list, projection, {
      clear: true,
      clearColor: options.clearColor,
      compiled: options.compiled,
    });
    if (drew) ports.paintGuard.bank(ports.list, projection, epoch);
    else ports.paintGuard.invalidate();
    ports.onPainted(drew);
    ports.onPaintTiming(ports.now() - started);
  }

  function publishPatch(next: MirrorState, changedIds?: Iterable<string>): DrawnSceneSnapshot<TWireGraph> | null {
    const previous = snapshot;
    if (previous === null || !listMatchesSnapshot) return null;
    // Patches retain the exact build/order/hit products they edited, but they
    // still create a new frame identity.  In particular, input and texture
    // admission must never consult composer-local "at patch" mirrors.
    const patched: DrawnSceneSnapshot<TWireGraph> = {
      ...previous,
      scene: previous.stateRevision === next.revision
        ? previous.scene
        : sceneForPatch(previous.scene, next, changedIds),
      // This is still a new snapshot/revision, but `buildEpoch` names full
      // builder output. Text and other build-keyed caches must not churn for
      // an in-place patch.
      buildEpoch: previous.buildEpoch,
      stateRevision: next.revision,
      inputEpoch: ports.inputEpoch(),
      resourceEpoch: ports.pixelEpoch(),
      textureReadyEpoch: ports.textureReadyEpoch(),
      // A new container makes the derived publication explicit while keeping
      // the O(changedIds) wire graph and hit buckets allocation-free.
      derived: { ...previous.derived },
    };
    snapshot = patched;
    return patched;
  }

  return {
    get snapshot() { return snapshot; },
    get listMatchesSnapshot() { return listMatchesSnapshot; },
    get builds() { return builds; },
    runBuild,
    publishPatch,
    paint,
    invalidatePaintGuard: () => ports.paintGuard.invalidate(),
    dispose: () => {
      listMatchesSnapshot = false;
      snapshot = null;
      capturedGlobalBuffers[0].clear();
      capturedGlobalBuffers[1].clear();
      captureIds.clear();
    },
  };
}

export function createCanvasFramePresentationRuntime<TWireGraph>(
  options: CanvasFramePresentationOptions<TWireGraph>,
): CanvasFramePresentationRuntime<TWireGraph> {
  let pixelForce = 0;
  let paintedFrames = 0;
  let skippedPaints = 0;
  let frame!: CanvasFrameRuntime<TWireGraph>;
  frame = createCanvasFrameRuntime({
    ...options.framePorts,
    pixelEpoch: () => options.basePixelEpoch() + pixelForce,
    beforeDirectPaint: options.beforeDirectPaint,
    onPaintUnavailable: options.onPaintUnavailable,
    onPaintTiming: options.onDirectPaintTiming,
    onPaintSkipped: () => {
      skippedPaints++;
      options.onPaintSkipped();
    },
    onPainted: (drew) => {
      paintedFrames++;
      // A failed executor submission did not establish the banked picture.
      if (!drew) frame.invalidatePaintGuard();
      options.onPainted?.(drew);
    },
  });

  function paint(force = false): void {
    frame.paint({
      force,
      clearColor: options.clearColor,
      compiled: options.compiled,
    });
  }

  function buildAndPaint(
    next: MirrorState,
    buildOptions: CanvasFramePresentationBuildOptions = {},
  ): boolean {
    if (options.disposed()) return false;
    // Strict admission declines before overlay synchronization or presentation,
    // so a rejected mutable list cannot leak into a local repaint path.
    if (!frame.runBuild(next)) return false;
    options.syncOverlay(next);
    paint(buildOptions.force ?? false);
    return true;
  }

  function rebuildAndPaint(cause: CanvasLocalRebuildCause): boolean {
    const next = options.state();
    if (next === null) return false;
    return buildAndPaint(next, { force: cause === "snapshot" });
  }

  return {
    get frame() { return frame; },
    get paintedFrames() { return paintedFrames; },
    get skippedPaints() { return skippedPaints; },
    get pixelForce() { return pixelForce; },
    runBuild: (next) => frame.runBuild(next),
    notePixelsChanged: () => { pixelForce++; frame.invalidatePaintGuard(); },
    invalidatePaintGuard: () => frame.invalidatePaintGuard(),
    paint,
    buildAndPaint,
    rebuildAndPaint,
    patchChrome: (patch) => {
      // A strict candidate may have reset the shared arena while the previous
      // snapshot remains available for input. Never mutate/present that arena.
      if (!frame.listMatchesSnapshot) return false;
      const build = frame.snapshot?.build;
      if (build === undefined) return false;
      if (!patch(build)) return false;
      paint();
      return true;
    },
    dispose: () => frame.dispose(),
  };
}
