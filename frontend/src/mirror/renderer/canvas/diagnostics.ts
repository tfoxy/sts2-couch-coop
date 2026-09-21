import type {
  CanvasExecutor,
  CanvasTextureCache,
  CompiledDrawList,
  ExecutorTexture,
  RetainedRangeCache,
} from "@godot-scene-web/canvas";
import { DRAW_NINE_PATCH, DRAW_POLYLINE } from "@godot-scene-web/canvas";
import { PATCH_CHAIN_MAX, PATCH_TRANSFORM_CHAIN_MAX } from "@/mirror/canvas/listPatch";

import type { DrawListBuild } from "@/mirror/canvas/buildDrawList";
import { FX_KEY_PREFIX } from "@/mirror/canvas/fxSurfaces";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import { dumpCommandLines, dumpNum } from "@/mirror/canvas/paintDump";
import type { PaintGuard } from "@/mirror/canvas/paintGuard";
import { installSpreadAuditProbe, type SpreadAuditReport } from "@/mirror/canvas/spreadAudit";
import { installHandPoseProbe, type HandPoseReport } from "@/mirror/handPoseProbe";
import { installLandingLogProbe, type LandingLogReport } from "@/mirror/landingLog";
import { SPINE_KEY_PREFIX } from "@/mirror/canvas/spineSurfaces";
import { TEXT_KEY_PREFIX } from "@/mirror/canvas/textSurfaces";
import type { TextureBridge } from "@/mirror/canvas/textureBridge";
import type { CanvasInteractionRuntime } from "@/mirror/renderer/canvas/interactionRuntime";
import { CANVAS_IDLE_ANIMATION_FPS } from "@/mirror/renderer/canvas/frameRuntime";
import type {
  CanvasFramePresentationRuntime,
  CanvasFrameRuntime,
} from "@/mirror/renderer/canvas/frameRuntime";
import type {
  CanvasPatchExecutionRuntime,
  CanvasPatchRuntime,
} from "@/mirror/renderer/canvas/patchRuntime";
import type { CanvasFrameScheduler } from "@/mirror/renderer/canvas/frameScheduler";
import type { CanvasStageLifecycle, CanvasStageRuntime } from "@/mirror/renderer/canvas/stageRuntime";
import type { RetainedSubtreeRuntime } from "@/mirror/renderer/canvas/retainedSubtreeRuntime";
import type { CanvasVisualState } from "@/mirror/renderer/canvas/visualState";
import type { WireDeltaGraph } from "@/mirror/canvas/wireDeltaGraph";
import type { createEffectsOverlayRuntime } from "@/mirror/renderer/canvas/effectsOverlayRuntime";
import type { createPixelResources } from "@/mirror/renderer/canvas/pixelResources";
import type { createCanvasTextRuntime } from "@/mirror/renderer/canvas/textRuntime";
import { nodeTypeLeaf, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";

type CanvasEffectsRuntime = ReturnType<typeof createEffectsOverlayRuntime>;
type CanvasStageEffects = ReturnType<CanvasEffectsRuntime["attachStageOwned"]>;
type CanvasPixelResources = ReturnType<typeof createPixelResources>;
type CanvasTextRuntime = ReturnType<typeof createCanvasTextRuntime>;

/**
 * One renderer-owned, bounded timing census.  The scheduler has its own
 * cadence rings; this one owns the build/paint/patch phase rings that are
 * published together with the renderer identity.
 */
export interface CanvasDiagnosticMetrics {
  readonly buildMsSamples: readonly number[];
  readonly paintMsSamples: readonly number[];
  readonly directPaintMsSamples: readonly number[];
  readonly patchMsSamples: readonly number[];
  readonly overlayMsSamples: readonly number[];
}

export interface CanvasDiagnosticStatsBindings {
  readonly identity: {
    readonly disposed: () => boolean;
    readonly state: () => MirrorState | null;
  };
  readonly policy: {
    readonly idlePeriodMinSamples: number;
    readonly texturePaceDefaults: { readonly bytes: number; readonly count: number; readonly tiny: number };
  };
  readonly stage: {
    readonly runtime: CanvasStageRuntime;
    readonly lifecycle: CanvasStageLifecycle;
    readonly staticBackground: CanvasPixelResources["staticBackground"];
  };
  readonly frame: {
    readonly runtime: CanvasFrameRuntime<WireDeltaGraph>;
    readonly presentation: CanvasFramePresentationRuntime<WireDeltaGraph>;
    readonly executor: CanvasExecutor;
    readonly compiled: CompiledDrawList<ExecutorTexture | null>;
    readonly paintGuard: PaintGuard<ExecutorTexture | null>;
    /** String-facing list view used only by the gated paint dump. */
    readonly dumpList: CanvasDumpInput["list"];
  };
  readonly retained: {
    readonly runtime: RetainedSubtreeRuntime;
    readonly cache: RetainedRangeCache;
  };
  readonly schedule: CanvasFrameScheduler;
  readonly visual: CanvasVisualState;
  readonly patch: {
    readonly runtime: CanvasPatchRuntime<WireDeltaGraph>;
    readonly execution: CanvasPatchExecutionRuntime;
  };
  readonly resources: {
    readonly bridge: TextureBridge;
    readonly textures: CanvasTextureCache;
    readonly pixel: CanvasPixelResources;
  };
  readonly effects: {
    readonly runtime: CanvasEffectsRuntime;
    readonly stageOwned: CanvasStageEffects;
    readonly fxScreenTexture: () => "paint" | "withhold";
  };
  readonly interaction: CanvasInteractionRuntime;
  readonly text: CanvasTextRuntime;
}

/**
 * Typed grouped snapshot consumed by the diagnostics formatter.  Domains own
 * their state; diagnostics only reads the current values and never schedules,
 * mutates a list, or acknowledges a scene frame.
 */
export interface CanvasStatsSnapshot {
  readonly identity: {
    readonly instanceId: number;
    readonly createdAtMs: number;
    readonly disposed: boolean;
  };
  readonly policy: CanvasDiagnosticStatsBindings["policy"];
  readonly stage: CanvasDiagnosticStatsBindings["stage"];
  readonly frame: CanvasDiagnosticStatsBindings["frame"];
  readonly retained: CanvasDiagnosticStatsBindings["retained"];
  readonly schedule: CanvasFrameScheduler;
  readonly visual: CanvasVisualState;
  readonly patch: CanvasDiagnosticStatsBindings["patch"];
  readonly resources: CanvasDiagnosticStatsBindings["resources"];
  readonly effects: CanvasDiagnosticStatsBindings["effects"];
  readonly interaction: CanvasInteractionRuntime;
  readonly text: CanvasTextRuntime;
  readonly metrics: CanvasDiagnosticMetrics;
}

/** Read-only renderer ports. Only snapshotPaint invokes the established local paint path. */
export interface CanvasDiagnosticPorts {
  paintDumpEnabled(): boolean;
  snapshotReady(): boolean;
  snapshotPaint(): void;
  snapshotDataUrl(): string;
  requestFrame(callback: FrameRequestCallback): number;
  dump(): CanvasDumpInput | null;
  stats(): unknown;
  scrollProbe(nodeId?: string): unknown;
  trailProbe(): unknown;
  raiseProbe(): unknown;
  handPoses?(): HandPoseReport;
  landingLog?(): LandingLogReport;
  spreadAudit?(): SpreadAuditReport;
}

export interface CanvasDumpInput {
  list: Parameters<typeof dumpCommandLines>[0]["list"];
  /** The retained node map from the same atomically published frame as `list`. */
  nodes: ReadonlyMap<string, MirrorNode>;
  ranges: Parameters<typeof dumpCommandLines>[0]["ranges"];
  clipPushes: Map<string, number>;
  trailQuadIds: ReadonlySet<string>;
  overlayRecords: readonly { order: number; id: string; kind: string; transform: readonly number[]; w: number; h: number }[];
  textScaleFor(id: string, nodes: ReadonlyMap<string, MirrorNode>): number;
  textRows(): Iterable<string>;
}

/**
 * Keep the long-lived public formatter stable while making the composition
 * boundary explicit.  This adapter is deliberately internal: consumers get a
 * grouped snapshot, never an untyped property bag.
 */
function flattenCanvasStatsSnapshot(snapshot: CanvasStatsSnapshot) {
  const { identity, policy, stage, frame, retained, schedule, visual, patch, resources, effects, interaction, text, metrics } = snapshot;
  const frameSnapshot = frame.runtime.snapshot;
  const build: DrawListBuild | null = frameSnapshot?.build ?? null;
  const visualStats = visual.stats();
  const stageEffects = effects.stageOwned;
  const effectRuntime = effects.runtime;
  const staticBackground = stage.staticBackground;
  return {
    IDLE_PERIOD_MIN_SAMPLES: policy.idlePeriodMinSamples,
    TEXTURE_PACE_BYTES_DEFAULT: policy.texturePaceDefaults.bytes,
    TEXTURE_PACE_COUNT_DEFAULT: policy.texturePaceDefaults.count,
    TEXTURE_TINY_BYTES_DEFAULT: policy.texturePaceDefaults.tiny,
    animFrames: schedule.animFrames,
    armedParks: schedule.armedParks,
    armedRafs: schedule.armedRafs,
    backingH: stage.lifecycle.backingH,
    backingSnapped: stage.lifecycle.backingSnapped,
    backingW: stage.lifecycle.backingW,
    bridge: resources.bridge,
    build,
    buildMsSamples: metrics.buildMsSamples,
    builds: frame.runtime.builds,
    canvasRendererCreatedAtMs: identity.createdAtMs,
    canvasRendererInstanceId: identity.instanceId,
    compiledList: frame.compiled,
    contextLost: stage.lifecycle.contextLost,
    directPaintMsSamples: metrics.directPaintMsSamples,
    disposed: identity.disposed,
    executor: frame.executor,
    frameMsSamples: schedule.frameMsSamples,
    glyphBlocks: text.glyphBlocks,
    glyphs: text.glyphs,
    hintTransformRebased: visualStats.hintTransformRebased,
    idleAnimFps: CANVAS_IDLE_ANIMATION_FPS,
    idleEntries: { size: visualStats.idlePlans },
    idleFrames: visualStats.idleFrames,
    idleInvisible: visualStats.idleInvisible,
    idleLoopCount: visual.idleLoopCount,
    idlePatched: patch.execution.stats.idlePatched,
    idlePeriodSamples: schedule.idlePeriodSamples,
    idleRebuilds: visualStats.idleRebuilds,
    idleStageAdmittedEarlySlack: visualStats.idleStageAdmittedEarlySlack,
    idleStageAdmittedGaps: visualStats.idleStageAdmittedGaps,
    idleStageAdmittedPassive: visualStats.idleStageAdmittedPassive,
    idleStageBypasses: schedule.idleStageBypasses,
    idleStageMinAdmittedGap: visualStats.idleStageMinAdmittedGap,
    idleStageMissingPassive: visualStats.idleStageMissingPassive,
    idleStagePhaseResets: visualStats.idleStagePhaseResets,
    idleStageSkippedEarly: visualStats.idleStageSkippedEarly,
    intentEntries: { size: visualStats.intentCycles },
    intentSwaps: visualStats.intentSwaps,
    loop: visual.loop,
    mapStrokeLocals: visual.mapStrokeLocals,
    mapStrokePinReuses: visual.mapStrokePinReuses,
    offsetBuilds: interaction.offsetBuilds,
    offsetCoalesced: interaction.offsetCoalesced,
    overlayCounts: effectRuntime.counts,
    overlayMsSamples: metrics.overlayMsSamples,
    pace: resources.pixel.pace,
    paceTiny: resources.pixel.paceTiny,
    paintGuard: frame.paintGuard,
    paintMsSamples: metrics.paintMsSamples,
    paintedFrames: frame.presentation.paintedFrames,
    parkWakeups: schedule.parkWakeups,
    patchBailouts: patch.execution.stats.patchBailouts,
    get patchChainMax() { return patch.runtime.stats.patchChainMax; },
    patchMsSamples: metrics.patchMsSamples,
    get patchedFrames() { return patch.runtime.stats.patchedFrames; },
    get patchedNodes() { return patch.runtime.stats.patchedNodes; },
    get patchedQuads() { return patch.runtime.stats.patchedQuads; },
    pulledReconciles: schedule.pulledReconciles,
    rafDeliverySamples: schedule.rafDeliverySamples,
    rampFrames: interaction.rampFrames,
    retainedCache: retained.cache,
    retainedRuntime: retained.runtime,
    skippedPaints: frame.presentation.skippedPaints,
    sourcePatchedFrames: patch.execution.stats.sourcePatchedFrames,
    sourcePatchedNodes: patch.execution.stats.sourcePatchedNodes,
    sourcePatchedQuads: patch.execution.stats.sourcePatchedQuads,
    spine: effectRuntime.spine,
    spineHoisted: stageEffects.spineHoisted,
    spineQuadPeak: stageEffects.spineQuadPeak,
    stageRuntime: stage.runtime,
    staticBgStageActive: staticBackground.active,
    staticBgStageCommand: staticBackground.command,
    staticBgStageFailures: staticBackground.failures,
    staticBgStagePending: staticBackground.pending,
    staticBgStageReady: staticBackground.ready,
    textRuntime: text,
    texts: text.texts,
    trailStats: stageEffects.trailStats,
    get transformChainMax() { return patch.runtime.stats.transformChainMax; },
    get transformCommands() { return patch.runtime.stats.transformCommands; },
    get transformFrames() { return patch.runtime.stats.transformFrames; },
    get transformHits() { return patch.runtime.stats.transformHits; },
    get transformRecords() { return patch.runtime.stats.transformRecords; },
    get transformRoots() { return patch.runtime.stats.transformRoots; },
    tweenReparentDropped: visualStats.reparentDrops,
    wireBuildCauses: patch.execution.stats.wireBuildCauses,
    wireChangedCommands: patch.execution.stats.wireChangedCommands,
    wireDirectPatches: patch.execution.stats.wireDirectPatches,
    wireNodesVisited: patch.execution.stats.wireNodesVisited,
    wireSourcePatches: patch.execution.stats.wireSourcePatches,
    withheldPeak: effectRuntime.withheldPeak,
    fx: effectRuntime.fx,
    fxQuadBuilds: stageEffects.fxQuadBuilds,
    fxQuadPeak: stageEffects.fxQuadPeak,
    textures: resources.textures,
    fxScreenTexture: effects.fxScreenTexture(),
  };
}

/** Formats effect-surface telemetry; the source registry remains domain-owned. */
function canvasFxStats(
  build: DrawListBuild | null,
  fx: CanvasEffectsRuntime["fx"],
  fxQuadBuilds: number,
  fxQuadPeak: number,
  textures: CanvasTextureCache,
  fxScreenTexture: "paint" | "withhold",
): Record<string, unknown> | null {
  if (!fx) return null;
  const stats = fx.stats();
  return {
    ...stats,
    uploadMs: Math.round(stats.uploadMs * 100) / 100,
    maxUploadMs: Math.round(stats.maxUploadMs * 100) / 100,
    maxBuildUploadMs: Math.round(stats.maxBuildUploadMs * 100) / 100,
    quads: build?.stats.fxQuads ?? 0,
    maxQuads: fxQuadPeak,
    totalQuads: fxQuadBuilds,
    cacheUploads: textures.stats.uploads,
    cacheRespecs: textures.stats.respecs,
    screenTexture: fxScreenTexture
  };
}

/** Formats the complete canvas diagnostics envelope without scheduling or acknowledging work. */
export function canvasStats(snapshot: CanvasStatsSnapshot): unknown {
  const source = flattenCanvasStatsSnapshot(snapshot);
  const { IDLE_PERIOD_MIN_SAMPLES, TEXTURE_PACE_BYTES_DEFAULT, TEXTURE_PACE_COUNT_DEFAULT, TEXTURE_TINY_BYTES_DEFAULT, animFrames, armedParks, armedRafs, backingH, backingSnapped, backingW, bridge, build, buildMsSamples, builds, canvasRendererCreatedAtMs, canvasRendererInstanceId, compiledList, contextLost, directPaintMsSamples, disposed, executor, frameMsSamples, fx, fxQuadBuilds, fxQuadPeak, fxScreenTexture, glyphBlocks, glyphs, hintTransformRebased, idleAnimFps, idleEntries, idleFrames, idleInvisible, idleLoopCount, idlePatched, idlePeriodSamples, idleRebuilds, idleStageAdmittedEarlySlack, idleStageAdmittedGaps, idleStageAdmittedPassive, idleStageBypasses, idleStageMinAdmittedGap, idleStageMissingPassive, idleStagePhaseResets, idleStageSkippedEarly, intentEntries, intentSwaps, loop, mapStrokeLocals, mapStrokePinReuses, offsetBuilds, offsetCoalesced, overlayCounts, overlayMsSamples, pace, paceTiny, paintGuard, paintMsSamples, paintedFrames, parkWakeups, patchBailouts, patchChainMax, patchMsSamples, patchedFrames, patchedNodes, patchedQuads, pulledReconciles, rafDeliverySamples, rampFrames, retainedCache, retainedRuntime, skippedPaints, sourcePatchedFrames, sourcePatchedNodes, sourcePatchedQuads, spine, spineHoisted, spineQuadPeak, stageRuntime, staticBgStageActive, staticBgStageCommand, staticBgStageFailures, staticBgStagePending, staticBgStageReady, textRuntime, texts, textures, trailStats, transformChainMax, transformCommands, transformFrames, transformHits, transformRecords, transformRoots, tweenReparentDropped, wireBuildCauses, wireChangedCommands, wireDirectPatches, wireNodesVisited, wireSourcePatches, withheldPeak } = source;
  const p50 = (samples: readonly number[]): number => {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    return Math.round(sorted[sorted.length >> 1] * 100) / 100;
  };
  const p95 = (samples: readonly number[]): number => {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] * 100) / 100;
  };

      const ex = executor.stats;
      return {
        backend: "canvas",
        instance: { id: canvasRendererInstanceId, createdAtMs: canvasRendererCreatedAtMs, disposed },
        wave: "2a",
        // A frame is only "painted" once `execute` has actually run, which is what the bench readiness gate needs
        // to distinguish a mounted-but-blank stage from a rendered one.
        frames: paintedFrames,
        animFrames,
        // B1 — THE PAINTS THAT DID NOT HAPPEN, and the price of asking. `frames` above counts only the executes
        // that really ran, so `frames + paintSkip.skipped` is what this session would have painted before R21 and
        // the ratio is the lever's whole value on this screen. `cold` separates "nothing to compare against" (a
        // first paint, a resize, a context loss) from "compared and differed", because a lever that is quietly
        // never armed and a lever that is armed and always says no read the same without it. `compareMs` is the
        // cost side and must be read against `paintMsP50`: this is only a win while it stays far below it.
        paintSkip: {
          skipped: skippedPaints,
          asked: paintGuard.stats.asked,
          cold: paintGuard.stats.cold,
          compareMs: Math.round(paintGuard.stats.compareMs * 100) / 100,
          bankMs: Math.round(paintGuard.stats.bankMs * 100) / 100
        },
        // THE TWO ARM MODES, counted (M3). `parks` above zero says the timer path is live on this screen;
        // `parks` at zero with `animFrames` climbing says every wakeup was a display frame, which is either a
        // running tween (correct) or a deadline nobody is honouring (the pre-M3 bug).
        // …and `pulled` (R6 P6-A): animation frames that ran MirrorView's pending reconcile instead of a build of
        // their own. Every one of them is a build-and-paint pair that used to happen twice in one display frame.
        // …and `rampFrames` (R6 M5): frames on which a cosmetic-offset ramp moved something. Zero on every screen
        // that never raises a hand, and the evidence that the raise GLIDES rather than teleporting.
        schedule: { rafs: armedRafs, parks: armedParks, parkWakeups, pulled: pulledReconciles, rampFrames },
        commands: build?.stats.commands ?? 0,
        retainedSubtrees: {
          ...retainedRuntime.stats,
          execution: { ...retainedRuntime.stats.execution },
          invalidations: { ...retainedRuntime.stats.invalidations },
          rejected: { ...retainedRuntime.stats.rejected },
          cache: {
            ...retainedCache.stats,
            rebuildReasons: { ...retainedCache.stats.rebuildReasons },
            fallbackReasons: { ...retainedCache.stats.fallbackReasons },
          },
          // Process attribution is joined by the device harness. Null is a
          // real "unavailable" value and must never become a convincing zero.
          device: { rendererCpu: null, gpuProcessCpu: null, processRssBytes: null },
        },
        quads: ex.quads,
        batches: ex.batches,
        textureBinds: ex.textureBinds,
        maxBatchQuads: ex.maxBatchQuads,
        // Executor-local, so these are per latest execute rather than cumulative registry totals.
        // The device harness uses them to prove a strict-canvas glyph batch actually admitted (or
        // conservatively declined on atlas residency) instead of inferring from a URL knob.
        glyphs: {
          runs: ex.glyphRuns,
          drawCalls: ex.glyphDrawCalls,
          runBatches: ex.glyphRunBatches ?? 0,
          batchFallbacks: ex.glyphRunBatchFallbacks ?? 0
        },
        clips: build?.stats.clips ?? 0,
        nodes: build?.stats.nodes ?? 0,
        canvasNodes: build?.stats.canvas ?? 0,
        overlayNodes: build?.stats.overlay ?? 0,
        skipped: build?.stats.skip ?? 0,
        silent: build?.stats.silent ?? 0,
        overlayCounts,
        // THE MAP-QUILL PIN (R8). `pinned` is the number of strokes whose local
        // this stream has latched; `pinReuses` is how many times a build read one back instead of the wire's —
        // which is what says the pin is DOING something rather than merely being wired, because a stroke whose
        // producer never re-sent its local would look identical either way.
        mapStroke: { pinned: mapStrokeLocals.size, pinReuses: mapStrokePinReuses },
        // THE IDLE LOOPS (R4). `plans`
        // is what the resolver found, `transformLoops`/`alphaLoops` split them by the channel they drive, and
        // `invisible` counts the samples an off-screen loop did NOT take.
        //
        // `rebuilds` KEEPS ITS NAME AND ITS MEANING — frames on which a local anim MOVED a pose — because it is
        // what the fps cap was sized against and half a dozen published numbers are in its units. What changed in
        // R7 is that such a frame no longer has to rebuild: `patched` is the subtraction, so `rebuilds - patched`
        // is the count that still costs a walk. On the `opacity` default `patched` is 0 by construction.
        idle: {
          plans: idleEntries.size,
          transformLoops: idleLoopCount("transform"),
          alphaLoops: idleLoopCount("alpha"),
          frames: idleFrames,
          rebuilds: idleRebuilds,
          patched: idlePatched,
          fpsCap: idleAnimFps,
          displayBypasses: { ...idleStageBypasses },
          displayGate: {
            admittedPassive: idleStageAdmittedPassive,
            skippedEarly: idleStageSkippedEarly,
            missingPassive: idleStageMissingPassive,
            admittedEarlySlack: idleStageAdmittedEarlySlack,
            phaseResets: idleStagePhaseResets,
            minAdmittedGapMs: Number.isFinite(idleStageMinAdmittedGap) ? idleStageMinAdmittedGap : null,
            admittedGapP50Ms: idleStageAdmittedGaps.length > 0 ? p50(idleStageAdmittedGaps) : null
          },
          invisible: idleInvisible,
          achievedP50: idlePeriodSamples.length >= IDLE_PERIOD_MIN_SAMPLES ? p50(idlePeriodSamples) : null,
          rafDeliveryP50: rafDeliverySamples.length > 0 ? p50(rafDeliverySamples) : null
        },
        // THE GLYPH TICKER (R6). `cycles` is the intents currently animating and
        // `swaps` the frame changes this page has drawn — the second is what says the ticker is RUNNING, since a
        // settled census reads one glyph per intent whether it cycles or not.
        intents: { cycles: intentEntries.size, swaps: intentSwaps },
        // R2's INPUT, reported on BOTH settings: the paint order of the last stage-spanning opaque fill this
        // build drew, or -1. It is what the flip decision is measured against — a dialog recording should show a
        // real order here and a plain combat frame should show -1 — and it costs nothing to publish with the
        // lever off, which is the point (the evidence can be gathered before the behaviour is turned on).
        backstopOrder: build?.backstopOrder ?? -1,
        // The worst build's withholding, for the reason the fx block's `maxQuads` exists: the last build of a
        // settled screen has no live effects on EITHER arm, so it cannot tell a fixed hoist rule from a dead one.
        overlayWithheldPeak: withheldPeak,
        // The DOM arm's `mirrorWalkStats.hintTransformRebased` twin — see the counter's declaration. Cumulative
        // over the page's life, so a replay's total survives the settle a census is taken at.
        hintTransformRebased,
        tweenReparentDropped,
        textures: {
          referenced: build?.stats.textures ?? 0,
          resident: bridge.stats.resident,
          // `pending` counts loads in flight AND anything the pacer is holding back, so "referenced, not resident,
          // not failed" still reads as "still coming" with pacing on. `paced` is that second half on its own.
          pending: bridge.stats.pending,
          paced: bridge.stats.paced,
          paceReleases: bridge.stats.paceReleases,
          failed: bridge.stats.failed,
          oversized: bridge.stats.oversized,
          deferredQuads: bridge.stats.deferredQuads,
          evicted: bridge.stats.evicted,
          bytes: bridge.stats.bytes,
          // The storm, priced: total and worst-single `texImage2D` ms, the worst ONE BUILD's total (what pacing
          // flattens), and when the last upload landed — `lastUploadAt` against page start is time-to-all-resident.
          uploads: bridge.stats.uploads,
          uploadMs: Math.round(bridge.stats.uploadMs * 10) / 10,
          maxUploadMs: Math.round(bridge.stats.maxUploadMs * 10) / 10,
          maxBuildUploadMs: Math.round(bridge.stats.maxBuildUploadMs * 10) / 10,
          lastUploadAt: Math.round(bridge.stats.lastUploadAt),
          paceBytes: pace.bytes ?? TEXTURE_PACE_BYTES_DEFAULT,
          paceCount: pace.count ?? TEXTURE_PACE_COUNT_DEFAULT,
          // THE TINY-PAGE EXEMPTION (R6 P6-B1), the settings and what they bought: `paceExempt` counts the grants
          // the budget would otherwise have deferred, `paceTinyBytes` what they cost. Both zero on the `off` arm,
          // which is how a reader tells the A/B halves apart without reading the url.
          paceTinyLimit: paceTiny ?? TEXTURE_TINY_BYTES_DEFAULT,
          paceExempt: bridge.stats.paceExempt,
          paceTinyBytes: bridge.stats.paceTinyBytes,
          // THE RE-PACKER'S THREE NUMBERS, and they are deliberately here rather than only in `repack` below:
          // `bytes` counts what IS resident and these count what is not. A run with `pageBytesAvoided` at 62 MB
          // and `bytes` down by the same amount is the whole claim; `pageFallbacks` above zero is the anomaly.
          // THE RESIDENT CAP and what it cost. `evictedByCap` is deliberately NOT folded into `evicted`: an
          // age-out is a page nothing wants any more, a cap eviction is a page that may well be wanted next
          // build, and only the second one says the ceiling is too low for this screen. `pageBytes` is the
          // number the ceiling is compared against — page textures only, since the re-packer's regions and the
          // three effect populations each keep their own governor.
          residentCap: bridge.stats.residentCap,
          evictedByCap: bridge.stats.evictedByCap,
          pageBytes: bridge.stats.pageBytes,
          // OWNED PAGE PIXELS, and each of these answers a different question the other cannot.
          // `pageElementUploads` is the ONLY arm that can still re-decode a multi-megabyte page inside a build,
          // so it is the number that says whether the fix is in force: it should be ~0 wherever
          // `createImageBitmap` exists, and every unit of it is a candidate for the 14-40 ms decodes the Aug-28
          // phone trace measured. `pageDecodeFailed` above zero says WHY it is not (undecodable, or a capture
          // whose size disagreed with the page). And `maxPageDecodeSyncMs` is the honest cost side: a capture may
          // be a main-thread copy rather than an off-thread decode (gsw measured 576 ms on a GPU-resident
          // source), and this says how much of one — the claim being only that it is out of the ANIMATION FRAME,
          // never that it is free.
          pageDecodes: bridge.stats.pageDecodes,
          pageDecodeFailed: bridge.stats.pageDecodeFailed,
          pageDecodeStale: bridge.stats.pageDecodeStale,
          pageOwnedUploads: bridge.stats.pageOwnedUploads,
          pageElementUploads: bridge.stats.pageElementUploads,
          pageDecodeMs: Math.round(bridge.stats.pageDecodeMs * 100) / 100,
          maxPageDecodeSyncMs: Math.round(bridge.stats.maxPageDecodeSyncMs * 100) / 100,
          repackServed: bridge.stats.repackServed,
          pageBytesAvoided: bridge.stats.pageBytesAvoided,
          pageFallbacks: bridge.stats.repackPageFallbacks,
          // …and the module's own counters, published with the resource bridge.
          repack: bridge.repackStats()
        },
        // EFFECT SURFACES. A null here means the runtime is unavailable rather than that it found nothing.
        fx: canvasFxStats(build, fx, fxQuadBuilds, fxQuadPeak, textures, fxScreenTexture),
        // SPINE STILLS AS QUADS. The same null-means-unavailable rule the
        // fx block takes. `quads`/`maxQuads` are the builder's, the rest the registry's, and `hoisted` is the
        // honest residue: creatures the game paints over that are STILL riding the overlay (a clip that has not
        // decoded, a still the residency ceiling refused, the one-build decision lag). It renders exactly as it
        // did before the flag, which is why it is a row rather than a failure.
        spine: spine
          ? {
              ...spine.stats(),
              uploadMs: Math.round(spine.stats().uploadMs * 100) / 100,
              quads: build?.stats.spineQuads ?? 0,
              maxQuads: spineQuadPeak,
              hoisted: spineHoisted
            }
          : null,
        // LABEL RASTERS. The same null-means-unavailable rule the fx, spine
        // and trail blocks take. `quads` against `overlayCounts.text` is how much of a screen's text the canvas
        // owns; `overlayCounts.textHoisted` is the rest, and it is a row rather than a failure (a rich label, a
        // balanced reward row, a paced raster, a face still loading — each renders exactly as it does today).
        // `digestCollisions` MUST be 0: anything else means two labels share a texture and one draws wrong words.
        //
        // `resident: 0` WITH `surfaces` IN THE DOZENS IS NOT A LEAK AND NOT A RETENTION BUG, which cost one round
        // an investigation. It is what an IDLE registry looks like, and two independent mechanisms put it there
        // when the glyph path is on: `buildDrawList` asks `glyphSource` FIRST and only falls through to this
        // registry for the labels it refuses, so nothing names these surfaces; and `endBuild` releases a surface
        // nothing has named for `TEXT_EVICT_AFTER_BUILDS` (240) builds. A combat recording that rebuilds every
        // frame reaches 240 builds in ~20 seconds, so the reading is a CONSEQUENCE of a stage that was rebuilding
        // rather than patching — the same defect `THE GLYPH TERM` fixed. The counters that settle it are `uploads`
        // against `evicted` (they were rastered and aged out) versus `uploads: 0` (they were never rastered at
        // all), while labels that cannot be shaped fall through to this registry.
        text: texts
          ? {
              ...texts.stats(),
              rasterMs: Math.round(texts.stats().rasterMs * 100) / 100,
              uploadMs: Math.round(texts.stats().uploadMs * 100) / 100,
              quads: build?.stats.textQuads ?? 0,
              maxQuads: textRuntime.stats().textQuadPeak,
              // SIMPLE RICH (T12). `refusals` is keyed by CLASS on purpose: "which construct is holding this
              // screen back" is an actionable reading and "how many labels failed" is not.
              rich: { accepted: textRuntime.stats().richAccepted, refusals: Object.fromEntries(textRuntime.stats().richRefusals) }
            }
          : null,
        // THE GPU GLYPH PATH.
        //
        // `labels`/`runs` against `text.quads` is how the two text paths SPLIT a screen, and the `refused*`
        // family says by which rule the glyph path lost the rest: `refusedPpem` is the fidelity floor;
        // `refusedNoFace` and `refusedNoMetrics` are the two halves of a face that has not landed
        // yet (hb-gpu's bytes, and the DOM face whose ascent places the baseline) and should both reach 0 once the
        // faces do, and `refusedShape`/`refusedColor`/`refusedOutline` are expected to be 0 outright —
        // `refusedOutline` now meaning only "an outline colour this cannot read", not the old scope line.
        // `pass.dropped` must be 0 — anything else is a hole in a word.
        //
        // `runs` OUTPACES `labels` BY MORE THAN IT USED TO, and that is the outline rather than a regression: an
        // outlined, shadowed, N-line label is 3N runs (shadow, outline, fill) where it was 2N, and each run is a
        // draw call because hb-gpu carries colour, model and spread as uniforms.
        //
        // `belowFloorTrue` (R-A4) — runs EMITTED under the ppem-16 fidelity floor, cumulative, and published
        // beside `pass.runsBelowPpemFloor`, which is gsw's count of runs DRAWN under it. Same arithmetic, two
        // clocks: this one is in builds (comparable to `runs` on the line above), gsw's is in frames. Above zero
        // says the glyph approximation may be blurrier than the raster path — a finding to act on deliberately,
        // not a bug to silence. The whole
        // point of publishing it before anything gates on it is that the decision gets a number first.
        //
        // `blocks` (the shaped-block memo — see `glyphBlocks.ts`) is what makes
        // `labels` readable now that a hit skips `blockFor` entirely: `labels` counts SHAPINGS, `blocks.hits`
        // counts the labels that needed none, and their sum against `runs` is the screen's text. On a settled
        // screen `blocks.misses` stops climbing and `labels` stops with it — a `misses` that keeps rising on a
        // still screen is the defect this cache exists to remove, coming back.
        textGlyphs: glyphs
          ? {
              ...glyphs.stats(),
              runs: build?.stats.textGlyphRuns ?? 0,
              maxLabels: textRuntime.stats().textGlyphPeak,
              belowFloorTrue: textRuntime.stats().glyphFloorRuns,
              // `enabled: false` means the glyph renderer is alive but the consumer cache was explicitly
              // bypassed (or `auto` made it unsafe). It is deliberately distinct from `null`, which means no
              // glyph renderer exists at all.
              blocks:
                glyphs === null
                  ? null
                  : glyphBlocks
                    ? { enabled: true, ...glyphBlocks.stats(), layoutCalls: textRuntime.stats().glyphLayouts, measureTextCalls: textRuntime.stats().glyphMeasureText }
                    : { enabled: false, layoutCalls: textRuntime.stats().glyphLayouts, measureTextCalls: textRuntime.stats().glyphMeasureText }
            }
          : null,
        animActive: loop.activeCount(),
        // THE COMET ROOT DRIVE (R5 T-DR4), counted once per FLIGHT rather than once per frame. Top-level rather
        // than inside `trails` because it is not gated on `?trailCanvas`: this client votes `trailDrive` on its
        // socket whatever the ribbons are doing, so a zero here on a recording that contains flights means the
        // producer has stopped streaming a root that nothing is placing — the frozen-comet defect, whichever
        // backend is drawing.
        trailRootDrives: loop.trailRootDrives(),
        // CARD TRAILS, or null with `?trailCanvas=off` / `?cardTrails=off` — the same null-means-the-lever-is-off
        // rule the fx and spine blocks take, and here it matters more than anywhere else: a census is POST-SETTLE
        // and a comet lives only while a card is moving, so `quads` and `strokes` read zero on a healthy screen.
        // `quadPeak` and `strokesPeak` are what say the wiring ever fired; `latches` against `latchReleases` is
        // what says it let go again (a gap between them is a stroke pinned to a pose the wire has moved on from).
        trails: trailStats
          ? { ...trailStats, quads: build?.stats.trailQuads ?? 0 }
          : null,
        builds,
        // CPU wire-delta admission for ordinary wire deltas. `visited`
        // must track changedIds rather than scene size on a healthy direct path.
        wireDelta: {
          directPatches: wireDirectPatches,
          nodesVisited: wireNodesVisited,
          changedCommands: wireChangedCommands,
          sourcePatches: wireSourcePatches,
          buildCauses: { ...wireBuildCauses }
        },
        // EAGER SCROLL's price: builds this backend ran because an offset moved, and writes that rode an existing
        // one instead. A gesture frame should show one of the first and one of the second — two builds for one
        // pixel is the thing the coalescer exists to stop (see `writeLocalOffset`).
        offsetBuilds,
        offsetCoalesced,
        // TIER-3 PATCHING. Its counters distinguish no eligible frames from a patcher that declined every frame.
        //
        // `bailouts` IS THE DELIVERABLE even when `frames` is 0. Every animated frame that did not patch is
        // counted under the reason it did not, and the `transform` bucket in particular is the sizing number for
        // a tier-2 subtree splice — the tier this one is not.
        patch: {
          frames: patchedFrames,
          quads: patchedQuads,
          nodes: patchedNodes,
          chainMax: patchChainMax,
          chainLimit: PATCH_CHAIN_MAX,
          source: {
            frames: sourcePatchedFrames,
            quads: sourcePatchedQuads,
            nodes: sourcePatchedNodes,
            bailouts: {
              source: patchBailouts.source,
              shape: patchBailouts.sourceShape,
              texture: patchBailouts.sourceTexture
            }
          },
          transform: {
            frames: transformFrames,
            roots: transformRoots,
            commands: transformCommands,
            records: transformRecords,
            hits: transformHits,
            chainMax: transformChainMax,
            chainLimit: PATCH_TRANSFORM_CHAIN_MAX
          },
          bailouts: { ...patchBailouts }
        },
        buildMsP50: p50(buildMsSamples),
        paintMsP50: p50(paintMsSamples),
        // The direct arm is the active-combat performance baseline. It must not
        // remain specific to direct canvas submission.
        direct: {
          samples: directPaintMsSamples.length,
          p50Ms: p50(directPaintMsSamples),
          p95Ms: p95(directPaintMsSamples)
        },
        directP95Ms: p95(directPaintMsSamples),
        compiled: {
          plan: { ...compiledList.diagnostics },
          executor: {
            planBuilds: executor.stats.compiledPlanBuilds,
            planReuses: executor.stats.compiledPlanReuses,
            templateRangeUpdates: executor.stats.compiledTemplateRangeUpdates,
            gpuFullUploads: executor.stats.compiledGpuFullUploads,
            gpuRangeUploads: executor.stats.compiledGpuRangeUploads,
            cachedDrawCalls: executor.stats.compiledCachedDrawCalls
          }
        },
        // …and the phase between them. Read the THREE together: a frame is build + overlay + paint, so a total that
        // does not add up to the frame budget names a fourth cost (a texture upload, a gsw runtime) rather than any
        // of these. See `overlayMsSamples` for why this one is measured before it is optimised.
        overlayMsP50: p50(overlayMsSamples),
        /** A patch, end to end. Expected to be an order of magnitude under `buildMsP50` or it is not worth it. */
        patchMsP50: p50(patchMsSamples),
        /**
         * A whole animated frame — the number a patch is supposed to move, rather than the number it replaces. A
         * patched frame is `patchMs + overlayMs + paintMs`; a rebuilt one is `buildMs + overlayMs + paintMs`.
         */
        frameMsP50: p50(frameMsSamples),
        backingStore: `${backingW}x${backingH}`,
        // Whether compositor-aligned sizing produced that box. A live SWGL measurement needs this to separate
        // a valid alignment measurement from the invalid-rect fallback.
        backingSnapped,
        canvasStaticBg: {
          source: staticBgStageActive?.scenePath ?? staticBgStagePending?.scenePath ?? null,
          ready: staticBgStageReady,
          command: staticBgStageCommand,
          failures: staticBgStageFailures
        },
        contextLost,
        // Transitions (see handleContextLost): `contextLost` alone cannot distinguish "never lost" from
        // "lost and recovered", and only the second one is a stability finding.
        contextLosses: stageRuntime.contextLosses,
        contextRestores: stageRuntime.contextRestores
      };
}

const OWNER_KEY = "__mirrorCanvasStatsOwner";
const OWNED_GLOBALS = ["__mirrorCanvasStats", "__mirrorDrawListDump", "__mirrorScrollProbe", "__mirrorCanvasSnapshot", "__mirrorTrailProbe", "__mirrorRaiseProbe"] as const;

function commandRole(input: CanvasDumpInput, kind: number, texture: string | null, node: MirrorNode | undefined, seenFill: boolean): string {
  if (kind === DRAW_POLYLINE) return "line";
  if (node !== undefined && input.trailQuadIds.has(node.id)) return "trail";
  if (texture?.startsWith(FX_KEY_PREFIX)) return "fx";
  if (texture?.startsWith(TEXT_KEY_PREFIX)) return "text";
  if (texture?.startsWith(SPINE_KEY_PREFIX)) return "spine";
  if (kind === DRAW_NINE_PATCH || texture !== null) return "tex";
  const paintsFill = node?.fillColor != null && node.shaderId == null && node.fillColor.a > 0;
  return paintsFill && !seenFill ? "fill" : "range";
}

/** One row per command plus the overlay/text surfaces that share the paint. */
export function canvasDrawListDump(input: CanvasDumpInput | null): string[] {
  if (input === null) return [];
  const lines = dumpCommandLines({
    list: input.list,
    nodes: input.nodes,
    ranges: input.ranges,
    clipPushes: input.clipPushes,
    roleOf: (kind, texture, node, seenFill) => commandRole(input, kind, texture, node, seenFill)
  });
  for (const record of input.overlayRecords) {
    const m = record.transform;
    const tscale = record.kind === "text" ? input.textScaleFor(record.id, input.nodes) : 1;
    lines.push(`O ${record.order} ${record.id} ${record.kind}` +
      ` type=${nodeTypeLeaf(input.nodes.get(record.id)?.nodeType ?? "") || "-"}` +
      ` m=${dumpNum(m[0])},${dumpNum(m[1])},${dumpNum(m[2])},${dumpNum(m[3])},${dumpNum(m[4])},${dumpNum(m[5])}` +
      ` wh=${dumpNum(record.w)},${dumpNum(record.h)} tscale=${dumpNum(tscale)}`);
  }
  lines.push(...input.textRows());
  return lines;
}

/** Capture in the same rAF task as the local paint; this never acknowledges a scene frame. */
export function canvasSnapshot(ports: CanvasDiagnosticPorts): Promise<string | null> {
  return new Promise((resolve) => {
    if (!ports.snapshotReady() || typeof requestAnimationFrame !== "function") return resolve(null);
    ports.requestFrame(() => {
      try {
        ports.snapshotPaint();
        resolve(ports.snapshotDataUrl());
      } catch {
        resolve(null);
      }
    });
  });
}

/** Owner-checked lifecycle for every canvas page global. */
export function createCanvasDiagnostics(owner: object, ports?: CanvasDiagnosticPorts) {
  let installed = false;
  const globals = (): Record<string, unknown> => window as unknown as Record<string, unknown>;
  const ownsGlobal = (): boolean => typeof window !== "undefined" && globals()[OWNER_KEY] === owner;
  const installOwner = (): void => {
    if (typeof window === "undefined") return;
    globals()[OWNER_KEY] = owner;
    installed = true;
  };
  const installProbes = (probes: Record<string, unknown>): void => {
    if (typeof window !== "undefined") Object.assign(globals(), probes);
  };
  return {
    installCanvasGlobals(): void {
      if (ports === undefined || typeof window === "undefined") return;
      installOwner();
      const probes: Record<string, unknown> = { __mirrorCanvasStats: ports.stats };
      if (ports.paintDumpEnabled()) {
        probes.__mirrorDrawListDump = () => canvasDrawListDump(ports.dump());
        probes.__mirrorScrollProbe = ports.scrollProbe;
        probes.__mirrorCanvasSnapshot = () => canvasSnapshot(ports);
        probes.__mirrorTrailProbe = ports.trailProbe;
        probes.__mirrorRaiseProbe = ports.raiseProbe;
      }
      installProbes(probes);
      if (ports.handPoses !== undefined) installHandPoseProbe(ports.handPoses, owner);
      if (ports.landingLog !== undefined) installLandingLogProbe(ports.landingLog, owner);
      if (ports.spreadAudit !== undefined) installSpreadAuditProbe(ports.spreadAudit, owner);
    },
    removeOwner(): boolean {
      if (!installed) return false;
      // The individual probe helpers have their own owner guards. Always ask them to release this renderer so an
      // audit-only old renderer cannot leave a stale seam behind after its replacement takes the stats owner.
      installHandPoseProbe(null, owner);
      installLandingLogProbe(null, owner);
      installSpreadAuditProbe(null, owner);
      if (!ownsGlobal()) return false;
      for (const name of OWNED_GLOBALS) delete globals()[name];
      delete globals()[OWNER_KEY];
      installed = false;
      return true;
    }
  };
}

const SAMPLE_CAP = 120;
let nextCanvasRendererInstanceId = 1;

interface CanvasDiagnosticMetricWriter extends CanvasDiagnosticMetrics {
  noteBuild(ms: number): void;
  notePaint(ms: number): void;
  noteDirectPaint(ms: number): void;
  notePatch(ms: number): void;
  noteOverlay(ms: number): void;
}

function createCanvasDiagnosticMetrics(): CanvasDiagnosticMetricWriter {
  const buildMsSamples: number[] = [];
  const paintMsSamples: number[] = [];
  const directPaintMsSamples: number[] = [];
  const patchMsSamples: number[] = [];
  const overlayMsSamples: number[] = [];
  const note = (into: number[], value: number): void => {
    if (into.length >= SAMPLE_CAP) into.shift();
    into.push(value);
  };
  return {
    buildMsSamples,
    paintMsSamples,
    directPaintMsSamples,
    patchMsSamples,
    overlayMsSamples,
    noteBuild: (ms) => note(buildMsSamples, ms),
    notePaint: (ms) => note(paintMsSamples, ms),
    noteDirectPaint: (ms) => note(directPaintMsSamples, ms),
    notePatch: (ms) => note(patchMsSamples, ms),
    noteOverlay: (ms) => note(overlayMsSamples, ms),
  };
}

export interface CanvasDiagnosticsRuntimeOptions {
  readonly urlParam: (name: string) => string | null;
  readonly now: () => number;
}

/** One fully formed late binding; no caller mutates an untyped ports object. */
export interface CanvasDiagnosticsInstallOptions {
  readonly stats: CanvasDiagnosticStatsBindings;
  readonly snapshotReady: () => boolean;
  /** Local rebuild/paint only. It never acknowledges a scene frame. */
  readonly snapshotPaint: () => void;
  readonly snapshotDataUrl: () => string;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly scrollProbe: (nodeId?: string) => unknown;
  readonly trailProbe: () => unknown;
  readonly raiseProbe: () => unknown;
  readonly handPoses?: () => HandPoseReport;
  readonly landingLog?: () => LandingLogReport;
  readonly spreadAudit?: () => SpreadAuditReport;
}

export interface CanvasDiagnosticsRuntime {
  readonly instanceId: number;
  readonly createdAtMs: number;
  readonly paintDumpEnabled: () => boolean;
  readonly metrics: CanvasDiagnosticMetrics;
  noteBuildTiming(ms: number): void;
  notePatchTiming(ms: number): void;
  noteOverlayTiming(ms: number): void;
  noteDirectPaint(elapsedMs: number): void;
  install(options: CanvasDiagnosticsInstallOptions): void;
  handRaiseDebug(): Record<string, unknown>;
  removeOwner(): boolean;
}

/**
 * Keep the renderer's observational projection at the diagnostics boundary.
 * The closures are deliberately passed through unchanged so identity, state,
 * and snapshot reads remain live instead of becoming construction snapshots.
 */
export function installCanvasRendererDiagnostics(
  runtime: CanvasDiagnosticsRuntime,
  stats: CanvasDiagnosticStatsBindings,
  ports: Omit<CanvasDiagnosticsInstallOptions, "stats">,
): void {
  runtime.install({ stats, ...ports });
}

function snapshotForDiagnostics(
  bindings: CanvasDiagnosticStatsBindings,
  identity: { instanceId: number; createdAtMs: number },
  metrics: CanvasDiagnosticMetrics,
): CanvasStatsSnapshot {
  return {
    identity: {
      instanceId: identity.instanceId,
      createdAtMs: identity.createdAtMs,
      disposed: bindings.identity.disposed(),
    },
    policy: bindings.policy,
    stage: bindings.stage,
    frame: bindings.frame,
    retained: bindings.retained,
    schedule: bindings.schedule,
    visual: bindings.visual,
    patch: bindings.patch,
    resources: bindings.resources,
    effects: bindings.effects,
    interaction: bindings.interaction,
    text: bindings.text,
    metrics,
  };
}

/**
 * Owns renderer identity, phase samples and page globals.
 * It is deliberately observational: the narrow callbacks supplied by the
 * composer remain the only route to local snapshot paint work.
 */
export function createCanvasDiagnosticsRuntime(
  options: CanvasDiagnosticsRuntimeOptions,
): CanvasDiagnosticsRuntime {
  const instanceId = nextCanvasRendererInstanceId++;
  const createdAtMs = options.now();
  const metrics = createCanvasDiagnosticMetrics();
  const owner = {};
  let globals: ReturnType<typeof createCanvasDiagnostics> | null = null;
  let bindings: CanvasDiagnosticStatsBindings | null = null;

  const paintDumpEnabled = (): boolean => {
    if (typeof window === "undefined") return false;
    if (import.meta.env.DEV) return true;
    const value = options.urlParam("paintDump");
    return value !== null && value !== "0" && value !== "off" && value !== "false";
  };
  const dump = (): CanvasDumpInput | null => {
    if (bindings === null) return null;
    const runtime = bindings.frame.runtime;
    const snapshot = runtime.snapshot;
    if (snapshot === null || !runtime.listMatchesSnapshot) return null;
    return {
      list: bindings.frame.dumpList,
      nodes: snapshot.scene.nodes,
      ranges: snapshot.build.ranges,
      clipPushes: new Map([...snapshot.build.clipRanges].map(([id, range]) => [id, range.push])),
      trailQuadIds: snapshot.build.trailQuadIds,
      overlayRecords: snapshot.build.overlayRecords,
      textScaleFor: (id, nodes) => bindings!.text.textScaleFor(resolveSceneInfo(id, nodes)),
      textRows: () => bindings!.text.dumpRows(),
    };
  };
  const handRaiseDebug = (): Record<string, unknown> => {
    if (bindings === null) return { backend: "canvas", wave: "2a", nodes: 0 };
    const { frame, stage, effects, interaction, visual } = bindings;
    const raise = interaction.raiseDebug();
    return {
      backend: "canvas",
      wave: "2a",
      nodes: bindings.identity.state()?.nodes.size ?? 0,
      backingStore: `${stage.lifecycle.backingW}x${stage.lifecycle.backingH}`,
      backingSnapped: stage.lifecycle.backingSnapped,
      contextLost: stage.lifecycle.contextLost,
      contextLosses: stage.runtime.contextLosses,
      contextRestores: stage.runtime.contextRestores,
      commands: frame.runtime.snapshot?.build.stats.commands ?? 0,
      quads: frame.executor.stats.quads,
      batches: frame.executor.stats.batches,
      overlay: effects.runtime.counts,
      animActive: visual.loop.activeCount(),
      raise: {
        enabled: raise.enabled,
        liftPx: raise.liftPx,
        maxLiftPx: raise.maxLiftPx,
        ...raise.gates,
        offsets: raise.offsets,
        movedRects: raise.movedRects,
        stamps: raise.stamps,
      },
      spread: { factor: visual.spreadFactor, shifted: visual.spreadDxByNode.size },
    };
  };
  return {
    instanceId,
    createdAtMs,
    paintDumpEnabled,
    metrics,
    noteBuildTiming: metrics.noteBuild,
    notePatchTiming: metrics.notePatch,
    noteOverlayTiming: metrics.noteOverlay,
    noteDirectPaint(elapsedMs): void {
      metrics.notePaint(elapsedMs);
      metrics.noteDirectPaint(elapsedMs);
    },
    install(next): void {
      bindings = next.stats;
      globals = createCanvasDiagnostics(owner, {
        paintDumpEnabled,
        snapshotReady: next.snapshotReady,
        snapshotPaint: next.snapshotPaint,
        snapshotDataUrl: next.snapshotDataUrl,
        requestFrame: next.requestFrame,
        dump,
        stats: () => canvasStats(snapshotForDiagnostics(bindings!, { instanceId, createdAtMs }, metrics)),
        scrollProbe: next.scrollProbe,
        trailProbe: next.trailProbe,
        raiseProbe: next.raiseProbe,
        handPoses: next.handPoses,
        landingLog: next.landingLog,
        spreadAudit: next.spreadAudit,
      });
      globals.installCanvasGlobals();
    },
    handRaiseDebug,
    removeOwner(): boolean {
      const removed = globals?.removeOwner() ?? false;
      globals = null;
      return removed;
    },
  };
}
