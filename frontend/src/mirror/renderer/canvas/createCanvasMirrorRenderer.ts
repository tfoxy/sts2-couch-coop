/**
 * Canvas mirror composition root. It owns backend construction, the
 * state-facing adapter, synchronous reconcile order, and reverse teardown;
 * frame transaction wiring belongs to frameAssembly.
 */
import {
  createDrawList,
  createRetainedRangeCache,
  compileDrawList,
  type DrawList,
  type CompiledDrawList,
  type ExecutorTexture
} from "@godot-scene-web/canvas";
import {
  createCanvasStageLifecycle,
  createCanvasStageRuntime,
  type CanvasStageLifecycle,
} from "@/mirror/renderer/canvas/stageRuntime";
import { createCanvasTextRuntime } from "@/mirror/renderer/canvas/textRuntime";
import {
  createPixelResources,
  TEXTURE_PACE_DEFAULTS
} from "@/mirror/renderer/canvas/pixelResources";
import { createEffectsOverlayRuntime } from "@/mirror/renderer/canvas/effectsOverlayRuntime";
import { createCanvasVisualState } from "@/mirror/renderer/canvas/visualState";
import { type CanvasFrameScheduler } from "@/mirror/renderer/canvas/frameScheduler";
import {
  type CanvasFramePresentationRuntime,
  type CanvasFrameRuntime
} from "@/mirror/renderer/canvas/frameRuntime";
import {
  createCanvasInteractionRuntime,
  type CanvasInteractionRuntime,
} from "@/mirror/renderer/canvas/interactionRuntime";
import {
  createCanvasDiagnosticsRuntime,
  installCanvasRendererDiagnostics,
  type CanvasDiagnosticStatsBindings
} from "@/mirror/renderer/canvas/diagnostics";
import { createCanvasFrameAssembly } from "@/mirror/renderer/canvas/frameAssembly";
import {
  canvasSubtreeCacheEnabled,
  createRetainedSubtreeRuntime,
} from "@/mirror/renderer/canvas/retainedSubtreeRuntime";

import { createPaintGuard } from "@/mirror/canvas/paintGuard";
import type {
  CanvasHandRaiseChrome,
  FullWalkCause,
  MirrorRenderer,
  ReconcilePull
} from "@/mirror/renderer/contracts";
import { type WireDeltaGraph } from "@/mirror/canvas/wireDeltaGraph";
import { setStageOwnsEffectPixels } from "@/mirror/shaderResources";
import {
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";
import { stagePixelRatio } from "@/render/quality";
import { rewardFocusSnapshotFromScene } from "@/mirror/rewardFocusSnapshot";

import { type CapturedGlobal } from "@/mirror/canvas/buildDrawList";

import { type FxRenderInfo, type FxSurfaceRegistry } from "@/mirror/canvas/fxSurfaces";
import { type SpineSurfaceRegistry } from "@/mirror/canvas/spineSurfaces";
import { type TextSurfaceRegistry } from "@/mirror/canvas/textSurfaces";
import { syncTextScaleSheet } from "@/mirror/textScaleClasses";
import { setUiScalingEnabled, uiScalingEnabled } from "@/mirror/uiScaling";
import { createHitMemo, resolveSceneInfo, type HitEntry, type HitMemo } from "@/mirror/canvas/hitTest";
import { createPaintOrderCache, type PaintOrder, type PaintOrderCache } from "@/mirror/canvas/paintOrder";
import { createPaintScratch, type PaintScratch } from "@/mirror/canvas/paintSpec";
import type { TextureBridge } from "@/mirror/canvas/textureBridge";
import { type TweenLoop } from "@/mirror/canvas/tweenLoop";

const EMPTY_CAPTURED_GLOBALS: ReadonlyMap<string, CapturedGlobal> = new Map();

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createCanvasMirrorRenderer(
  stage: HTMLElement,
  _defs: SVGElement,
  canvasHost?: HTMLElement | null
): MirrorRenderer {
  // Assigned after all scene/resource ports exist. Constructors above that
  // boundary can only request work through this narrow optional hook.
  let frameScheduler: CanvasFrameScheduler | null = null;
  let framePresentation: CanvasFramePresentationRuntime<WireDeltaGraph> | null = null;
  let pendingPixelChanges = 0;
  function noteLocalPixelsChanged(): void {
    if (framePresentation === null) {
      pendingPixelChanges++;
      return;
    }
    framePresentation.notePixelsChanged();
  }
  // The diagnostics runtime owns page-global identity, bounded phase samples,
  // dump policy. Its full observational binding is
  // installed only once every domain has been constructed below.
  const diagnostics = createCanvasDiagnosticsRuntime({
    urlParam,
    now: nowMs,
  });
  // The canvas host is fitted independently; scene coordinates stay on stage.
  const host = canvasHost ?? stage;
  const stageRuntime = createCanvasStageRuntime({
    stage,
    host,
    stagePixelRatio,
  });
  const { canvas, gsStage, gl } = stageRuntime;
  const designBox = stageRuntime.designBox;

  // Text policy and glyph readiness stay inside the text runtime; readiness only requests a local repaint.
  const textRuntime = createCanvasTextRuntime({
    gl,
    designBox,
    perDesignPx: () => stageRuntime.perDesignPx,
    // Font/glyph readiness changes local pixels only. In particular it must
    // not use the scene-frame acknowledgement path.
    onPixelsChanged: () => {
      noteLocalPixelsChanged();
      frameScheduler?.armAnimation(nowMs());
    },
  });
  const glyphs = textRuntime.glyphs;

  const { textures, executor } = stageRuntime.createExecutor({ glyphs: glyphs?.pass });
  const retainedCache = createRetainedRangeCache(gl);
  const retained = createRetainedSubtreeRuntime({
    enabled: canvasSubtreeCacheEnabled(typeof window === "undefined" ? "" : window.location.search),
    cache: retainedCache,
  });

  function glMaxTextureSize(): number {
    try {
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      return typeof max === "number" && Number.isFinite(max) && max > 0 ? max : 0;
    } catch {
      return 0;
    }
  }

  /** Observational probes only; rendering policy is fixed in this renderer. */
  function urlParam(name: string): string | null {
    if (name !== "spreadAudit" && name !== "paintDump") return null;
    return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name);
  }

  // DECLARED HERE, far from the rest of B1 (see `paint`), for one reason: `resize()` runs during CONSTRUCTION,
  // several hundred lines below, and it calls `clear()` — which invalidates this guard. A `const` initialised at
  // the paint site would still be in its temporal dead zone at that moment and the first resize of every session
  // would throw. The functions around it are declarations and hoist; this cannot.
  const paintGuard = createPaintGuard<ExecutorTexture | null>();

  const list: DrawList<ExecutorTexture | null> = createDrawList<ExecutorTexture | null>();
  const compiledList: CompiledDrawList<ExecutorTexture | null> = compileDrawList(list);
  const effectsRuntime = createEffectsOverlayRuntime({
    cache: textures, stage, canvas,
    maxTextureDim: glMaxTextureSize(), paintDumpEnabled: diagnostics.paintDumpEnabled(),
    perDesignPx: () => perDesignPx(), now: nowMs,
    armLocalPaint: () => frameScheduler?.armAnimation(nowMs()),
    scheduleTexturePaint: () => frameScheduler?.scheduleTexturePaint()
  });
  const fx: FxSurfaceRegistry = effectsRuntime.fx;

  const spine: SpineSurfaceRegistry | null = effectsRuntime.spine;

  // Text sources stay late-bound so readiness asks for local pixels, never a scene acknowledgement.
  const texts: TextSurfaceRegistry | null = textRuntime.attachSurfaces({
    cache: textures,
    maxTextureDim: glMaxTextureSize(),
    onFontReady: () => { frameScheduler?.armAnimation(nowMs()); }
  });
  const { glyphSource, textSource, glyphFloorProbe } = textRuntime.createSources({
    buildEpoch: () => frame.buildEpoch,
    state: () => state,
    resolveScene: resolveSceneInfo,
    imageSize: (url) => bridge.sizeOf(url),
    paintDumpEnabled: diagnostics.paintDumpEnabled
  });

  // Stage-owned effects must keep their pixels in canvas; the DOM swap remains vetoed.
  setStageOwnsEffectPixels(true);

  const pixelResources = createPixelResources({
    cache: textures, gl, designWidth: () => designBox().w, fx, spine, text: texts,
    onPixelsChanged: () => frameScheduler?.scheduleTexturePaint(),
  });
  const bridge: TextureBridge = pixelResources.bridge;
  const staticBg = pixelResources.staticBackground;
  const buildList = bridge.adapt(list);
  const scratch: PaintScratch = createPaintScratch();
  const paintOrderCache: PaintOrderCache = createPaintOrderCache();
  // Shared within-build scene and hit-test cache.
  const hitMemo: HitMemo = createHitMemo();

  // --- scene state ---------------------------------------------------------------------------------------------

  let state: MirrorState | null = null;
  let disposed = false;
  let lastOrderedIds: readonly string[] | null = null;
  /** Interaction is initialized after the visual loop; these build ports are lazy callbacks. */
  let interaction!: CanvasInteractionRuntime;
  /** Public build options that can change list output without a wire delta. */
  let buildInputEpoch = 0;

  function nodeOf(id: string): MirrorNode | undefined {
    return state?.nodes.get(id);
  }
  // Read-only accessors keep visual/text consumers on one drawn snapshot.
  const frame = {
    get order(): PaintOrder | null { return frameRuntime.snapshot?.paintOrder ?? null; },
    get hitEntries(): readonly HitEntry[] { return frameRuntime.snapshot?.hitEntries ?? []; },
    get capturedGlobals(): ReadonlyMap<string, CapturedGlobal> { return frameRuntime.snapshot?.capturedGlobals ?? EMPTY_CAPTURED_GLOBALS; },
    get buildEpoch(): number { return frameRuntime.snapshot?.buildEpoch ?? 0; },
  };

  // The visual runtime owns all retained animation channels.  The composer only
  // supplies scene facts and invokes it in the frame's established order.
  const visual = createCanvasVisualState({
    state: () => state,
    nodeOf,
    hasChildren,
    paintOrder: () => frame.order,
    hitEntries: () => frame.hitEntries,
    capturedGlobal: (id) => frame.capturedGlobals.get(id),
    cosmeticOffsetDy: (id) => interaction.cosmeticOffsets.get(id)?.dy ?? 0,
    effectivelyVisible: (node) => interaction.liveEffectivelyVisible(node),
    isLandingTarget: (id) => interaction.handHolderIds.has(id),
    onTransformArm: (id, at) => interaction.noteTransformArmPose(id, at),
    onNodePresent: (node) => interaction.noteNodePresent(node),
    onNodeRemoved: (id) => {
      interaction.noteNodeRemoved(id);
      fx.release(id);
      stageEffects.releaseTrail(id);
      effectsRuntime.forgetTrailLatch(id);
    },
    onRewrite: () => {
      stageEffects.resetTrails();
      effectsRuntime.clearTrailLatches();
      interaction.noteRewrite();
    },
    onFlights: (flights, at) => stageEffects.noteTrailFlights(flights, at)
  }, {
    clockOriginMs: nowMs(),
    now: nowMs,
    spreadAuditEnabled: urlParam("spreadAudit") !== null,
    noteIdlePeriod: (at) => frameScheduler?.noteIdlePeriod(at)
  });
  const loop: TweenLoop = visual.loop;
  const transformOverrides = visual.transformOverrides;
  const spreadDxByNode = visual.spreadDxByNode;
  const spreadFieldModeByNode = visual.spreadFieldModeByNode;
  const spreadAudit = visual.spreadAudit;

  // All client-owned input state and every painted-frame query live behind
  // this boundary. The callbacks are intentionally lazy: frame/scheduler
  // construction follows, while interaction requests only happen afterwards.
  interaction = createCanvasInteractionRuntime({
    state: () => state,
    snapshot: () => frameRuntime.snapshot,
    now: nowMs,
    disposed: () => disposed,
    stage,
    stageScale,
    designWidth: () => designBox().w,
    spreadFactor: () => visual.spreadFactor,
    spreadDxByNode,
    spreadFieldModeByNode,
    loop: () => loop,
    streamedGlobalInto: visual.streamedGlobalInto,
    rebuildAndPaint: () => framePresentation?.rebuildAndPaint("offset"),
    armAnimation: () => frameScheduler?.armAnimation(nowMs()),
    builds: () => frameRuntime.builds,
    paintedFrames: () => framePresentation?.paintedFrames ?? 0,
  });

  const stageEffects = effectsRuntime.attachStageOwned({
    bridge,
    trailConfig: {
      enabled: true,
      nodeOf,
      childIdsOf: (id) => interaction.liveChildIds(id),
      streamedGlobalInto: (id, out) => visual.streamedGlobalInto(state, id, out),
      overrideOf: (id) => transformOverrides.get(id) ?? null,
      spreadDxOf: (id) => spreadDxByNode.get(id) ?? 0,
      loopOwnsTransform: (id) => loop.ownsTransform(id)
    }
  });

  function hasChildren(nodeId: string): boolean {
    return frame.order !== null && frame.order.childrenOf(nodeId).length > 0;
  }

  function stageScale(): number {
    return stageRuntime.stageScale();
  }
  function perDesignPx(): number {
    return stageRuntime.perDesignPx;
  }

  // Browser events own only local framebuffer/resource work. A context or
  // resize event is never a scene-frame acknowledgement path.
  const stageLifecycle: CanvasStageLifecycle = createCanvasStageLifecycle(stageRuntime, {
    beforeContextLost: () => {
      pixelResources.staticBackgroundContextLost();
    },
    // The lifecycle installs and clears eagerly, before presentation exists.
    // Keep its bank invalidation at the primitive guard rather than crossing a
    // construction-time presentation boundary.
    invalidatePaintGuard: () => paintGuard.invalidate(),
    afterContextLost: () => {
      retained.contextLost();
      executor.invalidate();
      textures.reset();
      pixelResources.contextLost();
      effectsRuntime.contextLost();
      textRuntime.invalidate();
    },
    contextRestored: () => {
      textRuntime.restore();
    },
    backingChanged: () => {
      retained.invalidateAll("resize");
    },
    // This port is installed before the presentation runtime exists; an early
    // browser resize may only repaint once that frame boundary is live.
    hasDrawnFrame: () => framePresentation?.frame.snapshot !== null,
    paintAfterResize: () => framePresentation?.paint(),
    hasState: () => state !== null,
    rebuildAfterRestore: () => framePresentation?.rebuildAndPaint("restore"),
  });

  // The frame assembly owns construction-time frame/patch/scheduler cycles.
  // Reconcile ordering and public renderer behaviour remain below.
  let frameRuntime!: CanvasFrameRuntime<WireDeltaGraph>;
  const frameAssembly = createCanvasFrameAssembly({
    state: () => state,
    disposed: () => disposed,
    buildInputEpoch: () => buildInputEpoch,
    now: nowMs,
    stage: { lifecycle: stageLifecycle },
    draw: {
      list,
      buildList,
      executor,
      compiled: compiledList,
      paintGuard,
      projection: () => gsStage.projection(),
      paintOrderCache,
      hitMemo,
      scratch,
      retained,
    },
    resources: { bridge, textures, pixel: pixelResources, text: textRuntime },
    effects: { runtime: effectsRuntime, stageOwned: stageEffects },
    visual,
    interaction,
    textSources: { glyphSource, textSource, glyphFloorProbe },
    diagnostics,
    onPresentationCreated: (created) => {
      framePresentation = created;
      while (pendingPixelChanges > 0) {
        created.notePixelsChanged();
        pendingPixelChanges--;
      }
      frameRuntime = created.frame;
    },
  });
  const initialFramePresentation = frameAssembly.presentation;
  const patchRuntime = frameAssembly.patch;
  const patchExecution = frameAssembly.patchExecution;
  const scheduler = frameAssembly.scheduler;
  frameScheduler = scheduler;
  // --- the bench/diagnostic global -----------------------------------------------------------------------------

  const diagnosticStats: CanvasDiagnosticStatsBindings = {
    identity: { disposed: () => disposed, state: () => state },
    policy: {
      idlePeriodMinSamples: 3,
      texturePaceDefaults: TEXTURE_PACE_DEFAULTS,
    },
    stage: { runtime: stageRuntime, lifecycle: stageLifecycle, staticBackground: staticBg },
    frame: { runtime: frameRuntime, presentation: initialFramePresentation, executor, compiled: compiledList, paintGuard, dumpList: buildList },
    retained: { runtime: retained, cache: retainedCache },
    schedule: scheduler,
    visual,
    patch: { runtime: patchRuntime, execution: patchExecution },
    resources: { bridge, textures, pixel: pixelResources },
    effects: {
      runtime: effectsRuntime,
      stageOwned: stageEffects,
      fxScreenTexture: () => "withhold",
    },
    interaction,
    text: textRuntime,
  };
  installCanvasRendererDiagnostics(diagnostics, diagnosticStats, {
    snapshotReady: () => !disposed && !stageLifecycle.contextLost && state !== null,
    snapshotPaint: () => framePresentation?.rebuildAndPaint("snapshot"),
    snapshotDataUrl: () => canvas.toDataURL("image/png"),
    requestFrame: (callback) => requestAnimationFrame(callback),
    scrollProbe: interaction.scrollProbe,
    trailProbe: () => stageEffects.trailProbe(nowMs()),
    raiseProbe: interaction.raiseProbe,
    handPoses: interaction.handPoses,
    landingLog: visual.landingLogReport,
    spreadAudit: spreadAudit === null ? undefined : () => visual.spreadAuditReport()!,
  });

  // --- MirrorRenderer ------------------------------------------------------------------------------------------

  return {
    reconcile(next: MirrorState, _options?: { forceTextures?: boolean; reason?: FullWalkCause }): void | false {
      if (disposed) {
        return;
      }
      state = next;
      const at = nowMs();

      // STRUCTURAL DETECTION. `state.orderedIds` gets a new ARRAY REFERENCE exactly when the child structure
      // changed — the same signal the DOM backend selects its structural walk on, and the same one
      // `PaintOrderCache` detects for itself. Feeding `changedIds` in first is what drops only the sibling sorts a
      // z / show-behind move actually invalidated.
      const structural = next.orderedIds !== lastOrderedIds;
      if (!structural) {
        paintOrderCache.noteChanged(next, next.changedIds);
      }
      lastOrderedIds = next.orderedIds;

      visual.applyInputs(next, at);
      // A held card's lift is re-derived per frame: the finger may not have moved, but the card's node can have
      // been rebuilt under it, and the play-zone latch is a function of both.
      interaction.applyHeldLift();
      // …and the readable-hand raise, for the same reason: the hand's holders can have been rebuilt under a lift
      // that is still in force, and the drag / targeting / choice-prompt gates are all functions of THIS state.
      // Before the build, so this frame paints the raise it is about to publish stamps for — and before
      // `sweepAnimated`, which is what lets the ramp read a live tween's endpoint at this same `at`.
      interaction.applyHandRaisePass(at);
      staticBg.refresh(next, at);
      // Sample BEFORE the build so this frame paints the animation's current value rather than last frame's.
      visual.sample(at);
      // …and the comets, in the same order the animation frame takes them: the delta sampler needs `changedIds`
      // (cleared below), the flight sampler needs the pose the sweep just published, and the latch merge has to
      // land before the build reads its overrides.
      stageEffects.noteTrailDelta(next.changedIds, at);
      stageEffects.noteTrailFlightHeads(at);
      stageEffects.tickTrails(at);
      effectsRuntime.mergeTrailLatches(transformOverrides, loop);

      // An unchanged coalesced drain is common while the host catches up. A
      // guarded no-op avoids both a source walk and patch planning;
      // meaningful deltas enter the established direct patch planner.
      const wirePatched = patchExecution.tryUnchangedWireNoop(next, structural, at) || patchExecution.tryWireDeltaPatch(next, structural, at);
      if (!wirePatched && !initialFramePresentation.buildAndPaint(next)) {
        return false; // strict source load: no canvas presentation, DOM fallback, or wire ack
      }
      // THE LANDING ROWS, in this order and for two different reasons: the arms this drain collected can only be
      // priced once the build has banked their field claims, and a row can only SETTLE
      // against a frame that has been painted — the whole point is that it reads the picture the producer's word
      // produced, not the prediction it replaced.
      visual.flushLandingArms(next);
      visual.settleLanding(at);

      // CONSUME THE DELTA'S TWO ACCUMULATORS — the same point, and for the same reason, as the DOM backend's
      // (`state.changedIds.clear()` / `state.sceneRewrite = false` at the end of its walk). Both belong to the
      // STATE, not to a renderer: `applySceneDelta` keeps adding to them so that several deltas coalesced into one
      // rendered frame lose nothing, and whoever renders that frame is what marks them spent. Leaving them is not a
      // tidiness matter — it silently disables two things this backend depends on:
      //   * `sceneRewrite` would stay true for the rest of the session after the first keyframe, so EVERY reconcile
      //     would take the rewrite branch above and wipe `transformOverrides` / `alphaOverrides` / `visual.activeAnimIds`.
      //     Those maps ARE this backend's node state (see the header): a settled tween's pose, a hide-latch clamp
      //     and the pin's own bookkeeping all live there and are supposed to survive until a streamed value
      //     genuinely replaces them.
      //   * `changedIds` would grow monotonically towards the whole scene, so the per-delta loop above — and
      //     `paintOrderCache.noteChanged` — would re-do the entire tree on every frame instead of the delta.
      next.changedIds.clear();
      next.sceneRewrite = false;

      visual.advance(at);
      scheduler.armAnimation(nowMs());
    },

    // R6 P6-A. Accepted unconditionally and consumed only by the scheduler's
    // animation callback; a pulled reconcile remains the sole build/paint/ack.
    setReconcilePull(pull: ReconcilePull): void {
      scheduler.setReconcilePull(pull);
    },

    markTextureDirty(_ids: Iterable<string>): void {
      // A canvas has no per-node style to re-derive: the next build reads every texture size fresh, and MirrorView
      // always follows this call with a `scheduleRender()`. The repaint is scheduled anyway so a caller that does
      // NOT follow up still gets its pixels.
      scheduler.scheduleTexturePaint();
    },

    setStretch(factor: number): void {
      // The builder runs the spread walk itself from this number (see buildDrawList's header), so there is nothing
      // to invalidate here: MirrorView forces a structural reconcile after changing it, and the next build places
      // every node on the new field. The retained shift map is dropped so a floater cannot ride a stale claim from
      // the old factor for one frame.
      if (!visual.setStretch(factor)) {
        return;
      }
      buildInputEpoch++;
    },

    setHeldCard(id: string | null, _gameX: number, gameY: number, mode: "drag" | "peek" = "drag"): void {
      interaction.setHeldCard(id, gameY, mode);
    },

    setRaiseHandCards(enabled: boolean): void {
      interaction.setRaiseHandCards(enabled);
    },


    setUiScaling(enabled: boolean): void {
      // READABILITY SCALING on the canvas stage, and it is nearly nothing to do: a build is a pure function of the
      // state plus these flags, so moving them and rebuilding IS the flip. There is no stamped element to repair
      // (the DOM path's whole complication), no cache keyed on the old answer that survives a rebuild, and the
      // text half re-lays out because `textDeclsFor` is asked again for every label of the new build.
      //
      // The rebuild is asked for here rather than left to MirrorView's forced walk so a flip lands even when no
      // reconcile follows — a settled screen (a shop, a map, an open tooltip) is exactly where a viewer flips this.
      if (enabled === uiScalingEnabled()) {
        return;
      }
      setUiScalingEnabled(enabled);
      syncTextScaleSheet(); // the overlay's text elements are DOM and take the same sheet the DOM stage does
      initialFramePresentation.rebuildAndPaint("uiScaling");
    },

    raiseInputStamps: interaction.raiseInputStamps,
    handPresent: interaction.handPresent,
    handRaiseUiLayer: interaction.handRaiseUiLayer,


    setHandRaiseChrome(next: CanvasHandRaiseChrome | null): void {
      const had = pixelResources.chrome !== null;
      pixelResources.setChrome(next);
      if (
        had &&
        next !== null &&
        initialFramePresentation.patchChrome((build) => {
          const command = build.handRaiseChromeCommand;
          const anchorId = build.handRaiseAnchorId;
          const input = anchorId === null ? null : build.nodePaintInputs.get(anchorId) ?? null;
          return pixelResources.patchChrome(next, command, input, list);
        })
      ) return;
      if (state && had !== (next !== null)) initialFramePresentation.rebuildAndPaint("chrome");
    },

    handPoses: interaction.handPoses,
    landingLog: visual.landingLogReport,

    handRaiseDebug: diagnostics.handRaiseDebug,

    isCardTouchTarget: interaction.isCardTouchTarget,
    isHandCard: interaction.isHandCard,
    confirmTapTarget: interaction.confirmTapTarget,
    confirmTapAt: interaction.confirmTapAt,
    coverAbove: interaction.coverAbove,
    rewardFocusSnapshot(): ReturnType<MirrorRenderer["rewardFocusSnapshot"]> {
      const snapshot = frameRuntime.snapshot;
      return snapshot === null
        ? { screenId: null, rows: [] }
        : rewardFocusSnapshotFromScene(
            snapshot.scene.nodes,
            snapshot.scene.orderedIds,
            interaction.interactiveRects(),
            interaction.coverAbove
          );
    },

    setConfirmCoverWatch(_on: boolean): void {
      // Canvas scans the drawn snapshot at ask time; no DOM candidate set to arm.
    },

    handChoiceActive: interaction.handChoiceActive,
    mapDrawingToolActive: interaction.mapDrawingToolActive,
    interactiveRects: interaction.interactiveRects,
    viewScaleInputStamps: interaction.viewScaleInputStamps,
    endTurnBoxAt: interaction.endTurnBoxAt,
    eagerScrollTargets: interaction.eagerScrollTargets,
    isUnderNode: interaction.isUnderNode,

    consumeEffectsDirty(): { shader: boolean; particle: boolean } {
      return effectsRuntime.consumeDirty();
    },

    noteEffectRendered(node: HTMLElement, surface: HTMLCanvasElement, info?: FxRenderInfo): void {
      // A gsw runtime just PAINTED one of the overlay's hosts — a real draw, a frozen cache-hit blit, or a
      // clear that blanked a finished burst; all three write pixels this stage has to re-read. This is the
      // whole of the chain
      // that keeps an in-canvas effect moving: gsw's own effects rAF -> `onBindingRendered` -> here ->
      // `noteRendered` -> `onDirty` -> scheduler arm -> the animation rAF's rebuild, which is where the upload
      // (and the quad) actually happen. Nothing on it acknowledges a scene delta; an effect frame is not one.
      //
      // The node id comes off the element the OVERLAY stamped it on. gsw hands back the element it was told to
      // render, so this is a read of our own attribute, not a guess about gsw's DOM.
      if (disposed) {
        return;
      }
      effectsRuntime.noteEffectRendered(node, surface, info);
    },

    setStaticBackgroundShown(scenePath: string | null): void {
      if (!staticBg.setShown(scenePath)) return;
      if (state) {
        staticBg.refresh(state, nowMs());
        initialFramePresentation.rebuildAndPaint("offset");
      }
      effectsRuntime.markDirty();
    },

    setStaticBackgroundSource(
      source: { scenePath: string; url: string } | null,
      ready?: (ready: boolean) => void
    ): void {
      if (!staticBg.setSource(source, ready)) return;
      if (state) initialFramePresentation.rebuildAndPaint("texture");
    },

    __drainDormantHatchForTest(_budgetMs?: number): boolean {
      return false; // no hatchery: that is a DOM-construction scheduler, and there never will be one here
    },
    __drainRevealStaggerForTest(_budgetNodes?: number): number {
      return 0; // ditto for the staggered reveal
    },

    touchStackAt: interaction.touchStackAt,
    spreadPainterAt: interaction.spreadPainterAt,
    raisedHandVisualClaimAt: interaction.raisedHandVisualClaimAt,
    raisedHandTouchTargetClaim: interaction.raisedHandTouchTargetClaim,
    mapNodeAt: interaction.mapNodeAt,
    applyLocalOffset: interaction.applyLocalOffset,
    scrollRenderedY: interaction.scrollRenderedY,


    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      // The runtime owns and cancels both rAF lanes and its future-deadline
      // park. A late callback is inert even if the browser had already dequeued it.
      scheduler.dispose();
      interaction.dispose();
      state = null;
      frameRuntime.dispose();
      loop.reset();
      effectsRuntime.dispose();
      pixelResources.dispose();
      // AFTER the executor, and it matters: `dispose` deletes gsw's GL objects and then destroys the wasm module,
      // which frees every face copy in its heap. Dropping the registry without this leaks a whole face per font
      // for the life of the page.
      textRuntime.dispose();
      // The stage no longer owns anyone's effect pixels — un-latch the swap veto with it, or a DOM stage mounted
      // after this one (the hard fallback, a test that swaps backends) would inherit a refusal it never asked for.
      setStageOwnsEffectPixels(false);
      // B1 — drop the banked texture handles before the cache deletes the GL objects behind them. `disposed`
      // already refuses every `paint`, so this is hygiene rather than correctness: a renderer that is torn down
      // must not be the last thing holding a reference to a page's worth of texture wrappers.
      initialFramePresentation.invalidatePaintGuard();
      retained.dispose();
      executor.releaseCompiled(compiledList);
      // Executor and cache resources above are intentionally released before
      // stage teardown destroys their GL context.
      stageRuntime.dispose();
      diagnostics.removeOwner();
    }
  };
}
