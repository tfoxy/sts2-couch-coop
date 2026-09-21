/**
 * The construction-time cycle between atomic frames, list patches and the
 * scheduler. The renderer composer remains responsible
 * for wire reconcile order, its public adapter, state bridge, and disposal.
 */
import {
  type CanvasExecutor,
  type CanvasTextureCache,
  type CompiledDrawList,
  type DrawList,
  type ExecutorTexture,
  type StageProjection,
} from "@godot-scene-web/canvas";

import { buildDrawList } from "@/mirror/canvas/buildDrawList";
import type { HitMemo } from "@/mirror/canvas/hitTest";
import type { PaintOrderCache } from "@/mirror/canvas/paintOrder";
import type { PaintScratch } from "@/mirror/canvas/paintSpec";
import { captureWireDeltaGraph, type WireDeltaGraph } from "@/mirror/canvas/wireDeltaGraph";
import type { MirrorNode, MirrorState } from "@/mirror/sceneTree";
import type { TextureBridge } from "@/mirror/canvas/textureBridge";
import type { PaintGuard } from "@/mirror/canvas/paintGuard";
import type { CanvasInteractionRuntime } from "@/mirror/renderer/canvas/interactionRuntime";
import type { createCanvasDiagnosticsRuntime } from "@/mirror/renderer/canvas/diagnostics";
import {
  createCanvasFramePresentationRuntime,
  CANVAS_IDLE_ANIMATION_FPS,
  type CanvasFramePresentationRuntime,
  type CanvasFrameRuntime,
} from "@/mirror/renderer/canvas/frameRuntime";
import {
  CANVAS_FRAME_PARK_SLOP_MS,
  createCanvasFrameScheduler,
  type CanvasFrameScheduler,
} from "@/mirror/renderer/canvas/frameScheduler";
import {
  createCanvasPatchExecutionRuntime,
  createCanvasPatchRuntime,
  type CanvasPatchExecutionRuntime,
  type CanvasPatchRuntime,
} from "@/mirror/renderer/canvas/patchRuntime";
import type { CanvasStageLifecycle } from "@/mirror/renderer/canvas/stageRuntime";
import type { RetainedSubtreeRuntime } from "@/mirror/renderer/canvas/retainedSubtreeRuntime";
import type { CanvasVisualState } from "@/mirror/renderer/canvas/visualState";
import type { createCanvasTextRuntime } from "@/mirror/renderer/canvas/textRuntime";
import type { createEffectsOverlayRuntime } from "@/mirror/renderer/canvas/effectsOverlayRuntime";
import type { createPixelResources } from "@/mirror/renderer/canvas/pixelResources";

type CanvasDiagnosticsRuntime = ReturnType<typeof createCanvasDiagnosticsRuntime>;
type CanvasTextRuntime = ReturnType<typeof createCanvasTextRuntime>;
type CanvasEffectsRuntime = ReturnType<typeof createEffectsOverlayRuntime>;
type CanvasStageEffectsRuntime = ReturnType<CanvasEffectsRuntime["attachStageOwned"]>;
type CanvasPixelResources = ReturnType<typeof createPixelResources>;
type CanvasTextSources = ReturnType<CanvasTextRuntime["createSources"]>;

export interface CanvasFrameAssemblyOptions {
  readonly state: () => MirrorState | null;
  readonly disposed: () => boolean;
  readonly buildInputEpoch: () => number;
  readonly now: () => number;
  readonly stage: { readonly lifecycle: CanvasStageLifecycle; };
  readonly draw: {
    readonly list: DrawList<ExecutorTexture | null>;
    readonly buildList: DrawList<string>;
    readonly executor: CanvasExecutor;
    readonly compiled: CompiledDrawList<ExecutorTexture | null>;
    readonly paintGuard: PaintGuard<ExecutorTexture | null>;
    readonly projection: () => StageProjection;
    readonly paintOrderCache: PaintOrderCache;
    readonly hitMemo: HitMemo;
    readonly scratch: PaintScratch;
    readonly retained?: RetainedSubtreeRuntime;
  };
  readonly resources: {
    readonly bridge: TextureBridge;
    readonly textures: CanvasTextureCache;
    readonly pixel: CanvasPixelResources;
    readonly text: CanvasTextRuntime;
  };
  readonly effects: {
    readonly runtime: CanvasEffectsRuntime;
    readonly stageOwned: CanvasStageEffectsRuntime;
  };
  readonly visual: CanvasVisualState;
  readonly interaction: CanvasInteractionRuntime;
  readonly textSources: CanvasTextSources;
  readonly diagnostics: CanvasDiagnosticsRuntime;
  readonly onPresentationCreated: (
    presentation: CanvasFramePresentationRuntime<WireDeltaGraph>,
  ) => void;
}

export interface CanvasFrameAssembly {
  readonly presentation: CanvasFramePresentationRuntime<WireDeltaGraph>;
  readonly frame: CanvasFrameRuntime<WireDeltaGraph>;
  readonly patch: CanvasPatchRuntime<WireDeltaGraph>;
  readonly patchExecution: CanvasPatchExecutionRuntime;
  readonly scheduler: CanvasFrameScheduler;
}

export function createCanvasFrameAssembly(
  options: CanvasFrameAssemblyOptions,
): CanvasFrameAssembly {
  const {
    state, disposed, buildInputEpoch, now, stage, draw,
    resources, effects, visual, interaction, textSources, diagnostics,
  } = options;
  const { lifecycle: stageLifecycle } = stage;
  const {
    list, buildList, executor, compiled, paintGuard, projection,
    paintOrderCache, hitMemo, scratch, retained,
  } = draw;
  const { bridge, textures, pixel: pixelResources, text: textRuntime } = resources;
  const { runtime: effectsRuntime, stageOwned: stageEffects } = effects;
  const { glyphSource, textSource, glyphFloorProbe } = textSources;
  const { fx, spine, overlay } = effectsRuntime;
  const spineSource = stageEffects.spineSource;
  const staticBg = pixelResources.staticBackground;
  const handRaiseChromeSource = pixelResources.chromeSource;
  const textSnap = textRuntime.textSnap;
  const {
    transformOverrides, alphaOverrides, alphaApplied, localAnims, frameSubstitutes,
    opacitySampledIds, sourceSampledIds, spreadDxByNode, spreadFieldModeByNode,
    spreadRegistry, spreadAudit, viewScaleEnv, tipScaleEnv, pinnedLocals, loop,
  } = visual;
  const textureReadyEpoch = (): string =>
    bridge.stats.pending + ":" + bridge.stats.failed + ":" + bridge.stats.paceReleases;

  let frameRuntime!: CanvasFrameRuntime<WireDeltaGraph>;
  let patchRuntime!: CanvasPatchRuntime<WireDeltaGraph>;
  let patchExecution!: CanvasPatchExecutionRuntime;
  let presentation: CanvasFramePresentationRuntime<WireDeltaGraph> | null = null;

  const stateRevisionAtFrame = (): number => patchRuntime.revisionAtFrame();
  const idleDeadline = (at: number): number =>
    visual.idleDeadline(at, CANVAS_IDLE_ANIMATION_FPS, visual.idleStageNotBefore);
  function passiveStageDeadline(at: number): number {
    const due = Math.min(
      idleDeadline(at),
      overlay.nextSpineDeadline(at),
      fx?.nextDeadline(at) ?? Number.POSITIVE_INFINITY,
    );
    return Number.isFinite(due) ? Math.max(due, visual.idleStageNotBefore) : due;
  }
  function idleStageBypass(at: number) {
    if (Number.isFinite(interaction.offsetRampDeadline)) return "offset" as const;
    if (loop.hasPerFrameDemand(at)) return "tween" as const;
    if (loop.nextDeadline(at) <= at + CANVAS_FRAME_PARK_SLOP_MS) return "settle" as const;
    if (Number.isFinite(stageEffects.trailNextDeadline(at))) return "trail" as const;
    return null;
  }
  function syncOverlay(next: MirrorState): void {
    effectsRuntime.syncBuild(
      presentation?.frame.snapshot?.build ?? null,
      next,
      diagnostics.noteOverlayTiming,
    );
  }

  presentation = createCanvasFramePresentationRuntime({
    framePorts: {
      list,
      buildList,
      executor,
      projection,
      paintGuard,
      paintSkipEnabled: true,
      isUnavailable: () => stageLifecycle.contextLost || disposed(),
      inputEpoch: buildInputEpoch,
      textureReadyEpoch,
      now,
      buildScene: buildDrawList,
      prepareBuild: (next) => {
        effectsRuntime.prepareBuild();
        interaction.prepareBuild();
        patchRuntime.resetChains();
        visual.prepareBuild(next);
        textRuntime.beginBuild();
        pixelResources.beginBuild();
      },
      collectCaptureIds: (out) => interaction.collectCaptureIds(out),
      emitBuildPrefix: (target) => staticBg.emit(target),
      makeBuildOptions: (_next, globals, capturedIds) => ({
        resetList: false,
        paintOrderCache,
        hitMemo,
        scratch,
        textureSize: (url) => bridge.sizeOf(url),
        transformOverrides: transformOverrides.size > 0 ? transformOverrides : null,
        alphaOverrides: alphaOverrides.size > 0 ? alphaOverrides : null,
        cosmeticOffsets: interaction.cosmeticOffsets.size > 0 ? interaction.cosmeticOffsets : null,
        captureGlobals: capturedIds.size > 0 ? { ids: capturedIds, out: globals } : null,
        skipRoots: staticBg.skipRoots.size > 0 ? staticBg.skipRoots : null,
        spreadFactor: visual.spreadFactor,
        spreadRegistry,
        spreadDxOut: spreadDxByNode,
        spreadFieldModeOut: spreadFieldModeByNode,
        spreadAudit,
        viewScaleEnv,
        tipScaleEnv,
        pinnedLocals,
        localAnims: localAnims.size > 0 ? localAnims : null,
        frameSubstitutes: frameSubstitutes.size > 0 ? frameSubstitutes : null,
        fxSource: fx,
        spineSource,
        trailSource: stageEffects.trailSource,
        textSource,
        glyphSource,
        glyphFloor: glyphSource === null ? null : glyphFloorProbe,
        textSnap: textSource === null ? null : textSnap,
        handRaiseChrome: pixelResources.chrome === null ? null : handRaiseChromeSource,
      }),
      admitBuild: () => true,
      finalizeBuild: (_state, candidate) => {
        pixelResources.endBuild();
        pixelResources.finalizeStaticBackgroundBuild();
        effectsRuntime.finalizeBuild(candidate);
        if (textRuntime.texts) overlay.setTextDrawn(candidate.textQuadIds);
        textRuntime.endBuild(candidate.stats);
        overlay.setBackstop(candidate.backstopOrder >= 0 ? candidate.backstopOrder : null);
      },
      captureWireGraph: (next, candidate) => captureWireDeltaGraph(next, candidate.ranges),
      finalizeDerived: (_next, snapshot) => {
        interaction.publishBuild(snapshot);
        visual.bankAppliedAlphas();
      },
      onBuildTiming: diagnostics.noteBuildTiming,
      retained,
    },
    basePixelEpoch: () => {
      const textureStats = textures.stats;
      return textureStats.uploads + textureStats.respecs + textureStats.evictions;
    },
    compiled,
    state,
    disposed,
    syncOverlay,
    beforeDirectPaint: () => {},
    onDirectPaintTiming: diagnostics.noteDirectPaint,
    onPaintUnavailable: () => {},
    onPaintSkipped: () => {},
    onPainted: (drew) => {
      if (drew) retained?.noteExecution(executor.stats);
    },
  });
  options.onPresentationCreated(presentation);
  frameRuntime = presentation.frame;

  patchRuntime = createCanvasPatchRuntime({
    frame: frameRuntime,
    inputEpoch: buildInputEpoch,
    textureReadyEpoch,
    onPublished: (previous, snapshot) => interaction.publishPatch(previous, snapshot),
  });
  patchExecution = createCanvasPatchExecutionRuntime({
    patch: patchRuntime,
    frame: frameRuntime,
    state,
    list,
    now,
    contextLost: () => stageLifecycle.contextLost,
    textureReadyEpoch,
    fxDirty: () => fx !== null && fx.stats().dirty > 0,
    spineDirty: () => spine !== null && overlay.spineQuadVersion() !== effectsRuntime.spineQuadVersionAtBuild,
    trailDue: (at) => Number.isFinite(stageEffects.trailNextDeadline(at)),
    transformOverrides,
    alphaOverrides,
    alphaApplied,
    cosmeticOffsets: interaction.cosmeticOffsets,
    localAnims,
    frameSubstitutes,
    opacitySampledIds,
    sourceSampledIds,
    frameSampleMask: () => visual.frameSampleMask,
    intentNode: visual.intentNode,
    offsetPending: () => interaction.offsetPending,
    cosmeticVersion: () => interaction.cosmeticVersion,
    cosmeticVersionAtBuild: () => interaction.cosmeticVersionAtBuild,
    trailLatchVersion: () => effectsRuntime.trailLatchVersion,
    trailLatchVersionAtBuild: () => effectsRuntime.trailLatchVersionAtBuild,
    spreadDxOf: (id) => spreadDxByNode.get(id) ?? 0,
    resolveSource: (node: MirrorNode | undefined) => {
      const region = node?.textureRegion;
      const url = node?.textureUrl;
      const resident =
        url === null || url === undefined || region === null || region === undefined
          ? null
          : bridge.residentSource(url, { srcX: region.x, srcY: region.y, srcW: region.width, srcH: region.height });
      return {
        texture: resident?.handle ?? null,
        srcX: region === null || region === undefined ? Number.NaN : region.x + (resident?.dx ?? 0),
        srcY: region === null || region === undefined ? Number.NaN : region.y + (resident?.dy ?? 0),
        srcW: region?.width ?? Number.NaN,
        srcH: region?.height ?? Number.NaN,
      };
    },
    bankAppliedAlphas: visual.bankAppliedAlphas,
    invalidateInputCaches: interaction.invalidateInputCaches,
    notePatchTiming: diagnostics.notePatchTiming,
    syncOverlay,
    present: () => presentation!.paint(),
  });
  const scheduler = createCanvasFrameScheduler<MirrorState>({
    now,
    state,
    disposed,
    revisionAtFrame: stateRevisionAtFrame,
    idleAnimFps: () => CANVAS_IDLE_ANIMATION_FPS,
    deadlines: {
      offsetRampDeadline: () => interaction.offsetRampDeadline,
      loopDeadline: (at) => loop.nextDeadline(at),
      loopHasPerFrameDemand: (at) => loop.hasPerFrameDemand(at),
      trailDeadline: (at) => stageEffects.trailNextDeadline(at),
      passiveDeadline: passiveStageDeadline,
      idleStageBypass,
      idleStageNotBefore: () => visual.idleStageNotBefore,
    },
    animation: {
      advanceOffsetRamps: interaction.advanceOffsetRamps,
      noteIdleStageMissingPassive: () => visual.noteIdleStageMissingPassive(),
      noteIdleStageSkippedEarly: () => visual.noteIdleStageSkippedEarly(),
      noteIdleStageAdmission: (at, minimumFrameMs) => visual.noteIdleStageAdmission(at, minimumFrameMs),
      sampleVisual: (at) => visual.sample(at),
      noteTrailFlightHeads: (at) => stageEffects.noteTrailFlightHeads(at),
      tickTrails: (at) => stageEffects.tickTrails(at),
      mergeTrailLatches: () => effectsRuntime.mergeTrailLatches(transformOverrides, loop),
      advanceVisual: (at) => visual.advance(at),
      tickSpine: (at) => overlay.tickSpine(at),
      tryPatchAndPaint: (at) => patchExecution.tryPatchAndPaint(at),
      runBuild: frameRuntime.runBuild,
      syncOverlay,
      paintAction: () => presentation!.paint(),
      settleLanding: (at) => visual.settleLanding(at),
      rebuildAndPaintTexture: () => presentation!.rebuildAndPaint("texture"),
    },
  });
  return {
    presentation,
    frame: frameRuntime,
    patch: patchRuntime,
    patchExecution,
    scheduler,
  };
}
