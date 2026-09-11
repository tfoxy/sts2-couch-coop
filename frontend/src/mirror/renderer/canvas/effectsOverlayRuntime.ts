import type {
  CanvasTextureCache,
} from "@godot-scene-web/canvas";

import {
  AUTHORED_TRAIL_DIET,
  createCardTrailState,
  type CardTrailState,
  type TrailDietState,
} from "@/mirror/canvas/cardTrailState";
import type { TextureBridge } from "@/mirror/canvas/textureBridge";
import {
  createFxSurfaces,
  FX_FPS_DEFAULT,
  FX_PACE_BYTES_DEFAULT,
  FX_PACE_COUNT_DEFAULT,
  FX_RESIDENT_BYTES_DEFAULT,
  type FxRenderInfo,
  type FxSurfaceRegistry,
} from "@/mirror/canvas/fxSurfaces";
import {
  createMirrorOverlay,
  type MirrorOverlay,
  type OverlayCounts,
} from "@/mirror/canvas/overlay";
import {
  type OverlayRecord,
  type SpineQuadBox,
  type TrailQuadSource,
} from "@/mirror/canvas/paintSpec";
import type { DrawListBuild, SpineQuadSource } from "@/mirror/canvas/buildDrawList";
import type { TweenLoop } from "@/mirror/canvas/tweenLoop";
import {
  createSpineSurfaces,
  SPINE_PACE_BYTES_DEFAULT,
  SPINE_PACE_COUNT_DEFAULT,
  type SpineSurfaceRegistry,
} from "@/mirror/canvas/spineSurfaces";
import type { MirrorNode, MirrorState } from "@/mirror/sceneTree";

export const EMPTY_OVERLAY_COUNTS: OverlayCounts = Object.freeze({
  text: 0,
  shader: 0,
  particles: 0,
  spine: 0,
  trail: 0,
  elements: 0,
  withheld: 0,
  fxHidden: 0,
  fxDeclined: 0,
  textHoisted: 0,
  clipped: 0,
  clipEmpty: 0,
  clipPolygon: 0,
  backstopWithheld: 0,
  coveredText: 0,
  coveredSpine: 0,
});

const EMPTY_SPINE_BOXES: ReadonlyMap<string, SpineQuadBox> = new Map();
const EMPTY_TRAIL_LATCHES: ReadonlyMap<string, readonly number[]> = new Map();

export interface EffectsOverlayRuntimeOptions {
  cache: CanvasTextureCache;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  maxTextureDim: number;
  paintDumpEnabled: boolean;
  perDesignPx(): number;
  now(): number;
  /** Schedules local animation paint only; it never acknowledges a scene frame. */
  armLocalPaint(): void;
  scheduleTexturePaint(): void;
}

export interface StageOwnedEffectsOptions {
  bridge: TextureBridge;
  trailConfig: {
    enabled: boolean;
    nodeOf(id: string): MirrorNode | undefined;
    childIdsOf(id: string): readonly string[] | undefined;
    streamedGlobalInto(id: string, out: number[]): boolean;
    overrideOf(id: string): number[] | null;
    spreadDxOf(id: string): number;
    loopOwnsTransform(id: string): boolean;
  };
}

type EffectBuild = Pick<
  DrawListBuild,
  "stats" | "spineQuadIds" | "overlayRecords"
>;

/** Owns all DOM-overlay and effect-surface lifecycle. */
export function createEffectsOverlayRuntime(
  options: EffectsOverlayRuntimeOptions,
) {
  const fxFps = FX_FPS_DEFAULT;
  const fx: FxSurfaceRegistry = createFxSurfaces({
    cache: options.cache,
    onDirty: options.armLocalPaint,
    paceBytes: FX_PACE_BYTES_DEFAULT,
    paceCount: FX_PACE_COUNT_DEFAULT,
    fps: fxFps,
    residentBytes: FX_RESIDENT_BYTES_DEFAULT,
    maxTextureDim: options.maxTextureDim,
    resolutionCensus: options.paintDumpEnabled,
    perDesignPx: options.perDesignPx,
  });
  const spine: SpineSurfaceRegistry | null = createSpineSurfaces({
    cache: options.cache,
    paceBytes: SPINE_PACE_BYTES_DEFAULT,
    paceCount: SPINE_PACE_COUNT_DEFAULT,
    maxTextureDim: options.maxTextureDim,
    onDecoded: options.scheduleTexturePaint,
  });
  const overlay: MirrorOverlay = createMirrorOverlay(options.stage, options.canvas, {
    onSpineReady: () => {
      options.armLocalPaint();
      options.scheduleTexturePaint();
    },
  });
  let shaderDirty = true;
  let particleDirty = true;
  let counts: OverlayCounts = EMPTY_OVERLAY_COUNTS;
  let withheldPeak = 0;
  let stageOwned: ReturnType<typeof createStageOwnedRuntime> | null = null;
  // Trail latches write the same transform map as visual sampling, but they
  // have an independent producer cadence. Keep their publication/version
  // together with the stage-owned trail source so patch admission cannot rely
  // on a coincidental live-ribbon deadline.
  const trailLatchIds = new Set<string>();
  let trailLatchVersion = 0;
  let trailLatchVersionAtBuild = 0;
  let spineQuadVersionAtBuild = 0;
  const syncRecords = (
    records: Parameters<MirrorOverlay["reconcile"]>[0],
    nodes: Map<string, MirrorNode>,
    drawnFx: ReadonlySet<string>,
    sampleMs?: (ms: number) => void,
  ): void => {
    const started = options.now();
    const result = overlay.reconcile(records, nodes, {
      declined: (id) => fx.declined(id),
      drawn: (id) => drawnFx.has(id),
    });
    sampleMs?.(options.now() - started);
    shaderDirty ||= result.shaderDirty;
    particleDirty ||= result.particleDirty;
    counts = result.counts;
    withheldPeak = Math.max(withheldPeak, result.counts.withheld);
  };
  return {
    fx,
    spine,
    overlay,
    fxFps,
    attachStageOwned(ports: StageOwnedEffectsOptions) {
      stageOwned = createStageOwnedRuntime(options, ports, fx, spine, overlay);
      return stageOwned;
    },
    /** Start a candidate build without making any candidate products public. */
    prepareBuild(): void {
      stageOwned?.beginBuild();
      trailLatchVersionAtBuild = trailLatchVersion;
      spineQuadVersionAtBuild = overlay.spineQuadVersion();
    },
    /** Close every stage-owned effect census before the frame snapshot publishes. */
    finalizeBuild(build: EffectBuild): void {
      stageOwned?.endBuild(build);
    },
    /**
     * Publish or withdraw trail-owned transform poses after the trail integrator
     * has ticked. This is local visual state only; it never paints or acks.
     */
    mergeTrailLatches(
      transformOverrides: Map<string, number[]>,
      loop: Pick<TweenLoop, "ownsTransform">,
    ): void {
      const frames = stageOwned?.trailLatchedFrames() ?? EMPTY_TRAIL_LATCHES;
      for (const id of trailLatchIds) {
        if (!frames.has(id)) {
          transformOverrides.delete(id);
          trailLatchIds.delete(id);
          trailLatchVersion++;
        }
      }
      for (const [id, pose] of frames) {
        if (loop.ownsTransform(id)) continue;
        // `latchedFrames` reuses its arrays; every publication can carry a
        // moved pose even for the same id.
        transformOverrides.set(id, pose as number[]);
        trailLatchIds.add(id);
        trailLatchVersion++;
      }
    },
    forgetTrailLatch(id: string): void {
      trailLatchIds.delete(id);
    },
    clearTrailLatches(): void {
      trailLatchIds.clear();
    },
    get trailLatchVersion(): number {
      return trailLatchVersion;
    },
    get trailLatchVersionAtBuild(): number {
      return trailLatchVersionAtBuild;
    },
    get spineQuadVersionAtBuild(): number {
      return spineQuadVersionAtBuild;
    },
    get counts(): OverlayCounts {
      return counts;
    },
    get withheldPeak(): number {
      return withheldPeak;
    },
    get fxResidentBytes(): number {
      return FX_RESIDENT_BYTES_DEFAULT;
    },
    consumeDirty(): { shader: boolean; particle: boolean } {
      const dirty = { shader: shaderDirty, particle: particleDirty };
      shaderDirty = false;
      particleDirty = false;
      return dirty;
    },
    noteEffectRendered(
      node: HTMLElement,
      surface: HTMLCanvasElement,
      info?: FxRenderInfo,
    ): void {
      const id = node.getAttribute("data-node-id");
      if (id !== null) fx.noteRendered(id, surface, info);
    },
    syncRecords,
    /** Reconcile the overlay from the exact successful frame build only. */
    syncBuild(
      build: Pick<DrawListBuild, "overlayRecords" | "fxQuadIds"> | null,
      next: MirrorState,
      sampleMs?: (ms: number) => void,
    ): void {
      if (build === null) return;
      syncRecords(build.overlayRecords, next.nodes, build.fxQuadIds, sampleMs);
    },
    /** Static-background transitions affect both DOM-backed effect families. */
    markDirty(): void {
      shaderDirty = true;
      particleDirty = true;
    },
    contextLost(): void {
      fx.invalidate();
      spine?.invalidate();
    },
    dispose(): void {
      overlay.dispose();
      fx.dispose();
      spine?.dispose();
    },
    stats(): Record<string, unknown> {
      return {
        fx: fx.stats(),
        spine: spine?.stats() ?? null,
        overlay: counts,
        withheldPeak,
        fxFps,
        fxFpsDefault: FX_FPS_DEFAULT,
        stageOwned: stageOwned?.stats() ?? null,
      };
    },
  };
}

/**
 * Stage-only producers have no DOM lifecycle.  Keeping their caches beside the
 * overlay registry makes their context and frame ownership a single boundary.
 */
function createStageOwnedRuntime(
  options: EffectsOverlayRuntimeOptions,
  ports: StageOwnedEffectsOptions,
  fx: FxSurfaceRegistry | null,
  spine: SpineSurfaceRegistry | null,
  overlay: MirrorOverlay,
) {
  let boxes: ReadonlyMap<string, SpineQuadBox> = EMPTY_SPINE_BOXES;
  const covered = new Set<string>();
  let spineQuadPeak = 0;
  let spineHoisted = 0;
  let fxQuadPeak = 0;
  let fxQuadBuilds = 0;
  const diet: TrailDietState = AUTHORED_TRAIL_DIET;
  const trails: CardTrailState | null =
    ports.trailConfig.enabled
      ? createCardTrailState({
          nodeOf: ports.trailConfig.nodeOf,
          childIdsOf: ports.trailConfig.childIdsOf,
          streamedGlobalInto: ports.trailConfig.streamedGlobalInto,
          overrideOf: ports.trailConfig.overrideOf,
          spreadDxOf: ports.trailConfig.spreadDxOf,
          loopOwnsTransform: ports.trailConfig.loopOwnsTransform,
          textureSizeOf: (url) => ports.bridge.sizeOf(url),
          diet: () => diet,
        })
      : null;
  const trailSource: TrailQuadSource | null =
    trails === null
      ? null
      : {
          stripFor: (id) => trails.stripFor(id),
          isProvablySilent: (id) => {
            const strip = trails.stripFor(id);
            return strip === null || strip.quads.length === 0;
          },
          textureFor: (id) => trails.textureFor(id),
          blendFor: (id) => trails.blendFor(id),
        };
  const spineSource: SpineQuadSource | null = spine === null
    ? null
    : {
        boxFor: (id) => boxes.get(id) ?? null,
        wanted: (id) => covered.has(id),
        admit: (id) => {
          const box = boxes.get(id);
          const quad = box ? overlay.spineQuads().get(id) : undefined;
          return box !== undefined && quad !== undefined
            ? spine.acquire(box.clipUrl, {
                source: quad.source,
                width: box.frameW,
                height: box.frameH,
                bytes: quad.bytes,
              })
            : false;
        },
      };
  return {
    spineSource,
    trailSource,
    get spineQuadPeak() {
      return spineQuadPeak;
    },
    get spineHoisted() {
      return spineHoisted;
    },
    get fxQuadPeak() {
      return fxQuadPeak;
    },
    get fxQuadBuilds() {
      return fxQuadBuilds;
    },
    trailLatchedFrames(): ReadonlyMap<string, readonly number[]> {
      return trails?.latchedFrames() ?? new Map();
    },
    trailNextDeadline(at: number): number {
      return trails?.nextDeadline(at) ?? Infinity;
    },
    noteTrailFlightHeads(at: number): void {
      trails?.noteFlightHeads(at);
    },
    tickTrails(at: number): void {
      trails?.tick(at);
    },
    resetTrails(): void {
      trails?.reset();
    },
    releaseTrail(id: string): void {
      trails?.release(id);
    },
    noteTrailFlights(
      flights: Parameters<CardTrailState["noteFlights"]>[0],
      at: number,
    ): void {
      trails?.noteFlights(flights, at);
    },
    noteTrailDelta(ids: ReadonlySet<string>, at: number): void {
      trails?.noteDelta(ids, at);
    },
    trailProbe(at: number) {
      return trails?.probe(at) ?? null;
    },
    get trailStats() {
      return trails?.stats() ?? null;
    },
    beginBuild(): void {
      boxes = spineSource === null ? EMPTY_SPINE_BOXES : overlay.spineQuads();
    },
    endBuild(build: {
      readonly stats: {
        readonly fxQuads: number;
        readonly spineQuads: number;
        readonly trailQuads: number;
      };
      readonly spineQuadIds: ReadonlySet<string>;
      readonly overlayRecords: readonly OverlayRecord[];
    }): void {
      if (fx) {
        fx.endBuild();
        fxQuadPeak = Math.max(fxQuadPeak, build.stats.fxQuads);
        fxQuadBuilds += build.stats.fxQuads;
      }
      if (spine) {
        spine.endBuild();
        overlay.setSpineDrawn(build.spineQuadIds);
        covered.clear();
        let hoisted = 0;
        for (const record of build.overlayRecords)
          if (record.kind === "spine" && record.coveredAbove) {
            covered.add(record.id);
            if (!build.spineQuadIds.has(record.id)) hoisted++;
          }
        spineHoisted = hoisted;
        spineQuadPeak = Math.max(spineQuadPeak, build.stats.spineQuads);
      }
      trails?.noteQuads(build.stats.trailQuads);
    },
    stats(): Record<string, unknown> {
      return {
        fxQuadPeak,
        fxQuadBuilds,
        spineQuadPeak,
        spineHoisted,
        trails: trails?.probe(options.now()) ?? null,
      };
    },
  };
}
