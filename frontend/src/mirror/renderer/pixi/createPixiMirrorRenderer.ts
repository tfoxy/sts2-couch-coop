import { createClipRectView, createDrawList, createNinePatchView, createPolylineView, createQuadView, createTexturedMeshView } from "@godot-scene-web/canvas";
import type { PixiDrawListRenderer, PixiGlyphProvider, PixiTextOutcomes, PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import {
  buildDrawList, streamedAlphasOf, type AlphaOverride, type BuildDrawListOptions, type CosmeticOffset, type DrawListBuild, type LocalAnim
} from "@/mirror/canvas/buildDrawList";
import { baselineOf, layoutText, resolveTextSpec, type TextSpan } from "@/mirror/canvas/textLayout";
import { parseSimpleRich } from "@/mirror/canvas/richSimple";
import { createPaintOrderCache } from "@/mirror/canvas/paintOrder";
import { createHiddenSubtreeMemo } from "@/mirror/canvas/hiddenSubtreeMemo";
import { createHitMemo, resolveSceneInfo } from "@/mirror/canvas/hitTest";
import { canvasBlend, createPaintScratch, nodeIsPainting, normalizeFlip, type NodePaintInput, type OverlayRecord } from "@/mirror/canvas/paintSpec";
import { atlasFitAffine } from "@/mirror/nodeStyles";
import { ensureNodeFonts, fontFaceInjectionVersion, loadMirrorFont } from "@/mirror/fonts";
import { resolveTextScaleDecls } from "@/mirror/textScaleClasses";
import { stageBackingSize } from "@/mirror/canvas/stageBacking";
import { renderQuality, stagePixelRatio } from "@/render/quality";
import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH, nodeTypeLeaf, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import type { CanvasHandRaiseChrome, InteractiveRect, MirrorRenderer, ReconcilePull, RewardFocusSnapshot, SpreadPainter, TouchStack } from "@/mirror/renderer/contracts";
import { rewardFocusSnapshotFromScene, type RewardFocusCandidates } from "@/mirror/rewardFocusSnapshot";
import { setStageOwnsEffectPixels } from "@/mirror/shaderResources";
import { setUiScalingEnabled } from "@/mirror/uiScaling";
import { mapPointerToGame } from "@/mirror/pointerMap";
import { spineClipUrl } from "@/mirror/spineAttributes";
import { loadSpineClip, type LoadedSpineClip } from "@/mirror/spineClip";
import { isStaticBackgroundSuppressibleRoot, staticBgTargetPathOf } from "@/mirror/renderer/staticBackgroundPolicy";
import { createCanvasInteractionRuntime } from "@/mirror/renderer/canvas/interactionRuntime";
import { CANVAS_IDLE_ANIMATION_FPS, type DrawnSceneSnapshot } from "@/mirror/renderer/canvas/frameRuntime";
import { createCanvasVisualState, type LandingPresentation } from "@/mirror/renderer/canvas/visualState";
import { CANVAS_FRAME_PARK_SLOP_MS, createCanvasFrameScheduler } from "@/mirror/renderer/canvas/frameScheduler";
import { effectiveMirrorQuality, effectiveMirrorRenderSettings, mirrorSettings } from "@/mirror/mirrorSettings";
import { emitWarmAckTrace, warmAckTraceEnabled } from "@/mirror/warmAckTrace";
import { isShaderInputNode } from "@/mirror/shaderAttributes";
import { emittedPrimitiveRows } from "@/mirror/renderer/semanticPaint";
import { nativeTextOriginCorrection, pixiShadowColor, semanticTextLayout } from "@/mirror/renderer/semanticTextLayout";
import { handRaiseChromeMatrix } from "@/mirror/handRaiseChrome";
import { installHandPoseProbe } from "@/mirror/handPoseProbe";
import { installLandingLogProbe } from "@/mirror/landingLog";
import { installSpreadAuditProbe } from "@/mirror/canvas/spreadAudit";
import { affineInverse, affineMul, type Affine } from "@/mirror/affine";
import { rendererComparisonConfig, setRendererRuntimeStatus } from "@/mirror/rendererComparison";
import { SAMPLE_LOCAL_ANIM, SAMPLE_OPACITY, SAMPLE_SELF_OPACITY, SAMPLE_SOURCE } from "@/mirror/canvas/tweenLoop";
import { createRetainedPixiComposition, type RetainedPixiPatch } from "./retainedComposition";
import { resolveRustFastFlags } from "./rustFastFlags";
import { createSceneCandidateIndex } from "./sceneCandidateIndex";
import { copyTransformOverrides, overrideAncestors, sameNodeExceptTransform, sameTransformOverrides, touchesOverrideLineage } from "./heldOverrides";
import type { GlyphPassRegistry, GlyphPassStats } from "@/mirror/canvas/glyphPass";
import { preparePixiGlyph } from "./pixiGlyphText";
import {
  buildPreparedText, composePreparedTextRecords, createFontCheckCache, createTextPrepCache,
  resolveSemanticTextSpec, type PreparedText, type TextPrepRefusal
} from "./rustTextPreparation";
import { createFrameLifecycleDiagnostic } from "./frameLifecycleDiagnostic";
import { createAsyncPresentationGate } from "./asyncPresentationGate";
import { emitBusyStartupEvent } from "./busyStartupEvent";
import { createProducerBuildReasons, type ProducerBuildSource, type ProducerExecutorEvent } from "./producerBuildReasons";
import { createCouchCanvasProfile, requireSingleProfileMode, type ProfileIdentity } from "./couchCanvasProfile";
import type { PixiCommandFrame, PixiCpuFrame, PixiDiagnostics, PixiGpuElapsed } from "@godot-scene-web/canvas/pixi";

type Readiness = "initializing" | "ready" | "failed";
type PresentationResult = { presented: boolean; reason?: string; revision?: number; completedFrames?: number };
type ExecutorOptions = { canvas: HTMLCanvasElement; width: number; height: number; designWidth: number; designHeight: number; startupRendererInstance?: number; onInvalidate: (reason?: "resource" | "present") => void; profile?: ReturnType<typeof createCouchCanvasProfile> };
type MirrorDrawExecutor = Omit<PixiDrawListRenderer<string>, "render" | "admitScene" | "patchScene" | "presentScene"> & {
  render(list: import("@godot-scene-web/canvas").DrawList<string>, text?: readonly PixiTextRecord[],
    profileIdentity?: ProfileIdentity): boolean | PresentationResult | Promise<boolean | PresentationResult>;
  admitScene(list: import("@godot-scene-web/canvas").DrawList<string>, text: readonly PixiTextRecord[], plan: import("@godot-scene-web/canvas/pixi").PixiScenePlan,
    diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity): PresentationResult | Promise<PresentationResult>;
  patchScene(patch: import("@godot-scene-web/canvas/pixi").PixiScenePatch<string>,
    diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity): PresentationResult | Promise<PresentationResult>;
  presentScene(diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity): PresentationResult | Promise<PresentationResult>;
};
export type MirrorDrawExecutorFactory = (options: ExecutorOptions) => Promise<MirrorDrawExecutor>;
function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}
function resultPresented(value: unknown): boolean {
  return value === true || (!!value && typeof value === "object" && (value as { presented?: unknown }).presented === true);
}
let nextInstance = 1;

export interface PixiRendererDiagnostics {
  backend: "pixi" | "rust";
  instance: number;
  readiness: Readiness;
  ready: boolean;
  failure?: string;
  omissions?: { nodes: Record<string, string>; textures: readonly string[] };
  refinementFailure?: string;
  admittedRevision?: number;
  asyncSubmissionRevision?: number | null;
  asyncPresentedRevision?: number | null;
  asyncAwaitingAckRevision?: number | null;
  frameIdentity: Record<string, unknown> | null;
  resources: { pending: number; failed: number };
  pendingBreakdown?: { initializing: number; textures: number; fonts: number; spines: number; glyphs: number; refinement: number; presentation: number };
  draw: Record<string, number>;
  lifecycle: { disposed: number; contexts: number; contextReady: number; presentationValid: number };
  effective: Record<string, unknown>;
  text: PixiTextOutcomes | null;
  glyphs: GlyphPassStats | null;
}

function contains(rect: InteractiveRect, x: number, y: number): boolean {
  const m = rect.transform;
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-9) return false;
  const px = x - rect.spreadDx - m[4];
  const py = y - rect.raiseDy - m[5];
  const lx = (m[3] * px - m[2] * py) / det;
  const ly = (-m[1] * px + m[0] * py) / det;
  const r = rect.localRect;
  return lx >= r.x && ly >= r.y && lx <= r.x + (rect.renderedWidth || r.width) && ly <= r.y + r.height;
}

export function createPixiMirrorRenderer(
  stage: HTMLElement, _defs: SVGElement, canvasHost?: HTMLElement | null,
  onStatus?: (phase: Readiness, reason?: string) => void,
  options: { backend?: "pixi" | "rust"; createExecutor?: MirrorDrawExecutorFactory } = {}
): MirrorRenderer {
  const backend = options.backend ?? "pixi";
  const instance = nextInstance++;
  const profileRunId = backend === "rust" ? new URLSearchParams(window.location.search).get("canvasProfileRun") : null;
  const contentTrace = backend === "rust" && new URLSearchParams(window.location.search).get("contentTrace") === "1";
  const profile = profileRunId ? createCouchCanvasProfile(instance, profileRunId) : undefined;
  let profileBuildAttempts = 0;
  if (profile) {
    const activeProfile = profile;
    (window as unknown as { __mirrorCanvasProfile?: () => ReturnType<ReturnType<typeof createCouchCanvasProfile>["snapshot"]> }).__mirrorCanvasProfile = () => activeProfile.snapshot();
  }
  const startupEnabled = backend === "rust" && typeof (window as unknown as {
    __benchBusyStartupEvent?: unknown }).__benchBusyStartupEvent === "function";
  const completionCandidate = (window as unknown as { __benchStartupPresentationComplete?: unknown }).__benchStartupPresentationComplete;
  const startupCompletionHook = backend === "rust" && typeof completionCandidate === "function"
    ? completionCandidate as () => void : null;
  const commitCandidate = (window as unknown as { __benchStartupCommittedPresentation?: unknown }).__benchStartupCommittedPresentation;
  const startupCommitHook = backend === "rust" && typeof commitCandidate === "function"
    ? commitCandidate as (detail: Record<string, unknown>) => void : null;
  const startupDocumentNonce = startupCommitHook
    ? (window as unknown as { __benchDocumentNonce?: string }).__benchDocumentNonce ?? null : null;
  const noteStartupCommit = (sceneRevision: number, result: PresentationResult | boolean | undefined,
    identity: Record<string, unknown>) => {
    if (!startupCommitHook || !result || typeof result !== "object" || result.presented !== true) return;
    startupCommitHook({ documentNonce: startupDocumentNonce, rendererInstance: instance,
      sceneRevision, backendRevision: result.revision ?? null,
      completedFrames: result.completedFrames ?? null, frameIdentity: identity, presented: true });
  };
  const startupEvent = (name: string, detail: Record<string, unknown> = {}) => {
    if (startupEnabled) emitBusyStartupEvent(name, { instance, ...detail });
  };
  startupEvent("renderer.create", { backend, documentNonce: (window as unknown as {
    __benchDocumentNonce?: string }).__benchDocumentNonce ?? null,
    width: stage.clientWidth, height: stage.clientHeight });
  const host = canvasHost ?? stage;
  const canvas = stage.ownerDocument.createElement("canvas");
  canvas.className = `mirror-canvas-stage mirror-${backend}-stage`;
  Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", pointerEvents: "none" });
  host.insertBefore(canvas, host.firstChild);
  const list = createDrawList<string>();
  const scratch = createPaintScratch();
  const paintOrderCache = createPaintOrderCache();
  const hitMemo = createHitMemo();
  const texts: PixiTextRecord[] = [];
  const textOwners = new Map<string, string>();
  const textKeysByOwner = new Map<string, string[]>();
  const measureCanvas = stage.ownerDocument.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");
  const textLayoutCache = new Map<string, { key: string; layout: ReturnType<typeof layoutText>; metrics: { ascent: number; descent: number } }>();
  // The replay clock waits for real renderer events. Its waiter is installed before a build so a
  // resource that settles during admission cannot be missed; normal scheduling is unchanged.
  let diagnosticWakeGeneration = 0;
  const diagnosticWakeWaiters = new Set<() => void>();
  let cancelDiagnosticClock: ((reason: string) => void) | null = null;
  const signalDiagnosticWake = () => {
    if (!cancelDiagnosticClock) return;
    diagnosticWakeGeneration++;
    for (const wake of [...diagnosticWakeWaiters]) wake();
  };
  let fontVersion = 0;
  let nativeLayouts = 0;
  const onFontsLoaded = () => { if (producerReasons) resourceEpoch++; fontVersion++; textLayoutCache.clear(); if (state && readiness === "ready") { pendingTextureSource = "resource"; scheduler.scheduleTexturePaint(); } signalDiagnosticWake(); };
  stage.ownerDocument.fonts?.addEventListener?.("loadingdone", onFontsLoaded);
  let pixi: MirrorDrawExecutor | null = null;
  const attributionQuery = new URLSearchParams(window.location.search);
  const spreadAuditEnabled = attributionQuery.get("spreadAudit") === "1";
  const fast = resolveRustFastFlags(attributionQuery, backend);
  const paintOrderReuse = fast.paintOrderReuse;
  // Text-preparation and font-check caches (rustFast). Each is null when its switch is off; see
  // rustTextPreparation.ts for what each one validates. A font set without load events could never
  // invalidate the check cache, so such a document keeps checking directly.
  const textPrepCache = fast.textPrepCache ? createTextPrepCache() : null;
  const documentFonts = stage.ownerDocument.fonts;
  const fontCheckCache = fast.fontCheckCache && typeof documentFonts?.addEventListener === "function"
    ? createFontCheckCache(documentFonts, fontFaceInjectionVersion) : null;
  // R2-P3 (rustSceneIndex): a superset node-id index by leaf type, kept current from `next.changedIds` at
  // `reconcile` — see sceneCandidateIndex.ts. Used today for the two reward-focus types; the two lines at
  // `reconcile` below are the only place it is fed.
  const rewardCandidateIndex = fast.sceneIndex
    ? createSceneCandidateIndex((node) => {
      const leaf = nodeTypeLeaf(node.nodeType);
      return leaf === "NRewardsScreen" || leaf === "NRewardButton" ? [leaf] : [];
    })
    : null;
  // A node's static-background skip-root answer depends on its PARENT and GRANDPARENT (scene identity, not just
  // its own fields), so a changedIds-driven candidate set could miss a reclassification that only an ancestor's
  // own upsert reports. Memoized by node OBJECT IDENTITY instead: `applySceneDelta` replaces a node's object on
  // every upsert and never mutates one in place, so a cache hit can only ever be this exact node, unchanged.
  const staticBgSkipRootMemo = fast.sceneIndex ? new WeakMap<MirrorNode, boolean>() : null;
  const traceFrames = backend === "pixi" && attributionQuery.get("ccTraceFrames") === "1";
  const traceStamp = traceFrames && typeof console.timeStamp === "function"
    ? (label: string) => console.timeStamp(label) : null;
  let traceAttempt = 0;
  // Busy replay presents only a few frames per second. One in four attempts gives
  // a small set of joined Couch/Pixi spans without tracing every draw.
  const nextTraceFrame = (): string | null => {
    if (!traceStamp) return null;
    const attempt = ++traceAttempt;
    return attempt % 4 === 1 ? `${instance}.${attempt}` : null;
  };
  const tracePhase = <T>(id: string | null, phase: string, run: () => T): T => {
    if (id === null) return run();
    traceStamp!(`cc:frame:${id}:couch:${phase}:start`);
    try { return run(); }
    finally { traceStamp!(`cc:frame:${id}:couch:${phase}:end`); }
  };
  const tracePixi = <T>(id: string | null, run: () => T): T => {
    if (id === null) return run();
    const traced = pixi as PixiDrawListRenderer<string> & { setTraceFrameId?: (id: string | null) => void };
    traced.setTraceFrameId?.(id);
    try { return tracePhase(id, "submit", run); }
    finally { traced.setTraceFrameId?.(null); }
  };
  const rustDiagnosticMode = backend === "rust" && attributionQuery.get("rustDiagnostics") === "1";
  const rustPhaseTimingMode = backend === "rust" && attributionQuery.get("rustPhaseTiming") === "1";
  const producerReasonMode = backend === "rust" && attributionQuery.get("rustProducerReasons") === "1";
  const hiddenWalkMode = backend === "rust" && attributionQuery.get("rustHiddenWalk") === "1";
  if (hiddenWalkMode && !producerReasonMode) throw new Error("rustHiddenWalk requires rustProducerReasons=1 for build outcomes");
  const hiddenWalkRows: Array<{ buildId: number; revision: number; summary: import("@/mirror/canvas/buildDrawList").HiddenWalkSummary }> = [];
  let hiddenWalkOverflow = false;
  const rustExecutionPhaseMode = backend === "rust" && attributionQuery.get("rustExecutionPhases") === "1";
  requireSingleProfileMode(!!profile, rustExecutionPhaseMode);
  const rustOmitStaticPixelCaches = fast.omitStaticPixelCaches;
  const rustSkipHiddenHitCandidates = backend === "rust" && attributionQuery.get("rustSkipHiddenHitCandidates") === "1";
  const hiddenMemo = backend === "rust" && fast.hiddenMemo ? createHiddenSubtreeMemo({ captures: fast.hiddenMemoCaptures }) : null;
  const rustStaticAdmissionPhaseMode = backend === "rust" && attributionQuery.get("rustStaticAdmissionPhase") === "1";
  // The reviewed ack repair stays opt-in until a warm view/client capture qualifies it for the product default.
  const rustPendingAckRetry = backend === "rust" && attributionQuery.get("rustPendingAckRetry") === "1";
  const producerReasons = producerReasonMode ? createProducerBuildReasons(rustExecutionPhaseMode) : null;
  if (rustExecutionPhaseMode && (!producerReasons || typeof console.timeStamp !== "function"))
    throw new Error("Rust execution phases require rustProducerReasons=1 and console.timeStamp");
  if (rustStaticAdmissionPhaseMode && typeof console.timeStamp !== "function")
    throw new Error("Rust static admission phase requires console.timeStamp");
  const rustExecutionStamp = (label: string) => { if (rustExecutionPhaseMode) console.timeStamp(label); };
  let producerBuilds = 0, producerBuildMs = 0, retainedPlanCount = 0, retainedPlanMs = 0, retainedAsyncSubmitted = 0, retainedAsyncPublished = 0;
  const attributionEnabled = backend === "pixi" && attributionQuery.get("rendererCompare") === "1";
  const attributionMode = attributionEnabled ? attributionQuery.get("pixiAttribution") : null;
  const clipControl = attributionEnabled && attributionQuery.get("pixiClipControl") === "omit" ? "omit" as const : undefined;
  const requestedSubmitControl = attributionEnabled ? attributionQuery.get("pixiSubmitControl") : null;
  const submitControl = requestedSubmitControl === "skip-gl" || requestedSubmitControl === "single-quad"
    ? requestedSubmitControl : undefined;
  const commandFrames: PixiCommandFrame[] = [];
  const gpuElapsed: PixiGpuElapsed[] = [];
  const cpuFrames: PixiCpuFrame[] = [];
  const keep = <T>(rows: T[], row: T) => { rows.push(row); if (rows.length > 512) rows.shift(); };
  const pixiDiagnostics: PixiDiagnostics | undefined = attributionMode === "commands"
    ? { mode: "commands", onFrame: (frame) => keep(commandFrames, frame) }
    : attributionMode === "gpu-timer"
      ? { mode: "gpu-timer", onResult: (result) => keep(gpuElapsed, result) }
      : attributionMode === "cpu-ops"
        ? { mode: "cpu-ops", sampleEvery: 16, onFrame: (frame) => keep(cpuFrames, frame) }
      : undefined;
  const lifecycle = new URLSearchParams(window.location.search).has("frameLifecycle")
    ? createFrameLifecycleDiagnostic(() => performance.now()) : null;
  const completedDraws = () => pixi?.stats.completedFrames ?? 0;
  const beginLocalFrame = (source: "texture" | "refinement" | "local" | "clock") => {
    if (!lifecycle || lifecycle.inFrame) return;
    lifecycle.begin(source, state?.revision ?? -1, completedDraws());
    lifecycle.admit();
  };
  let glyphRegistry: GlyphPassRegistry | null = null;
  let refinementRaf: number | null = null;
  let refinementPending = false;
  let refinementFailure: string | null = null;
  let readiness: Readiness = "initializing";
  let failure: string | undefined;
  let presentedOnce = false;
  let startupPrepares = 0, startupSubmits = 0, startupCompletes = 0;
  let startupReadyEmitted = false;
  function noteStartupReady(revision: number | null): void {
    if (!startupEnabled || startupReadyEmitted) return;
    const current = diagnostics();
    if (!current.ready) return;
    startupReadyEmitted = true;
    startupEvent("renderer.firstReady", { revision,
      backingWidth: backingW, backingHeight: backingH, dpr,
      pending: current.resources.pending, failed: current.resources.failed });
  }
  function publishStatus(phase: Readiness, reason?: string): void {
    if (disposed) return;
    readiness = phase;
    if (reason) failure = reason;
    startupEvent("renderer.status", { phase, reason: reason ?? null });
    onStatus?.(phase, reason);
    if (phase === "failed") signalDiagnosticWake();
  }
  let disposed = false;
  let state: MirrorState | null = null;
  let build: DrawListBuild | null = null;
  let stretch = 1;
  let reconcilePull: ReconcilePull | null = null;
  let buildEpoch = 0;
  let frameEpoch = 0;
  let retainedPatches = 0;
  let retainedPatchObjects = 0;
  let retainedPatchFallbacks = 0;
  let retainedDecline = "not-attempted";
  let pendingTextureSource: "resource" | "resize" = "resource";
  let committedSizeEpoch = -1;
  let committedFontVersion = -1;
  let committedTextureCount = -1;
  let resourceEpoch = 0;
  let retained = null as ReturnType<typeof createRetainedPixiComposition> | null;
  const retainedDiagnosticFields = new Map<string, { alpha?: number; source?: { texture: string | null; x: number; y: number; w: number; h: number } }>();
  let retainedValid = false;
  // rustLazyComposition: a committed composition indexes its patch inputs on first use. `paintGeneration` moves
  // whenever paint() starts rewriting the list, texts and owners that index would read.
  let paintGeneration = 0, lazyCompositionIndexBuilds = 0, lazyCompositionVerifyMismatches = 0;
  let lazyCompositionVerifyFirstMismatch: string | null = null;
  const compositionLaziness = fast.lazyComposition ? { lazyPatchIndex: true, inputGeneration: () => paintGeneration,
    strictInputs: import.meta.env.MODE === "test" || fast.verify, onPatchIndex: () => { lazyCompositionIndexBuilds++; },
    verify: fast.verify ? { onMismatch: (method: string, detail: string) => {
      lazyCompositionVerifyMismatches++; lazyCompositionVerifyFirstMismatch ??= `${method}: ${detail}`; } } : undefined } : {};
  // rustSnapshotReuse: the live node map a pristine committed copy was taken from (null once a wire patch edits
  // that copy), plus the static-background skip roots of one (node map, revision, background).
  let snapshotNodesSource: ReadonlyMap<string, MirrorNode> | null = null;
  let staticSkipMemo: { nodes: ReadonlyMap<string, MirrorNode>; revision: number; background: object; roots: Set<string> } | null = null;
  let snapshotNodeReuses = 0, staticSkipRootReuses = 0, rewardFocusSkips = 0;
  // rustSceneIndex, under rustFastVerify: every mismatch between a candidate-restricted/memoized answer (reward
  // focus here; hand-present/cover-above in interactionRuntime.ts) and the full-scan ground truth. Zero on a
  // correct build, always — this is the one counter `rustFastParity.spec.ts` asserts stays 0 under every query.
  let sceneIndexVerifyMismatches = 0;
  // rustHeldOverridePatch: a value copy of the transform overrides the committed full build applied. Publishing a
  // full build is the only way `retainedValid` turns on, and it always replaces this bank; every path that turns it
  // off clears it. Patches planned under held overrides are remembered for the counters and for verification.
  let committedOverrides: ReadonlyMap<string, readonly number[]> | null = null;
  type HeldPatchInputs = { overrides: Map<string, readonly number[]>; alphas: Map<string, AlphaOverride>;
    anims: Map<string, LocalAnim>; substitutes: Map<string, MirrorNode>; offsets: Map<string, CosmeticOffset> };
  const heldPatches = new WeakMap<RetainedPixiPatch, HeldPatchInputs | null>();
  let heldOverridePatches = 0, heldOverrideVerifyRuns = 0, heldOverrideVerifyMismatches = 0, heldOverrideVerifyMaxError = 0;
  let heldOverrideVerifyFirstMismatch: string | null = null;
  const heldOverrideDeclines: Record<string, number> = {};
  // rustFastVerify: every verify run that found a mismatch, with all of its notes and the builds and patches that
  // led up to it (a short ring, recorded under verify only). Both bounded so a long session cannot grow them.
  type HeldVerifyEntry = { run: number; revision: number; clock: number | null; notes: string[]; recent: string[] };
  const heldOverrideVerifyLog: HeldVerifyEntry[] = [];
  const heldOverrideRecent: string[] = [];
  const noteHeldEvent = (event: () => string) => {
    if (!fast.verify || !fast.heldOverridePatch) return;
    heldOverrideRecent.push(event());
    if (heldOverrideRecent.length > 24) heldOverrideRecent.shift();
  };
  const retainedMode = rendererComparisonConfig.pixiScene === "retained";
  const textMode = backend === "rust" ? "native" : rendererComparisonConfig.pixiText;
  const asyncPresentation = createAsyncPresentationGate();
  let asyncPresentedRevision: number | null = null;
  let asyncSubmissionRevision: number | null = null;
  let asyncPresentationSizeEpoch = 0;
  let asyncAwaitingAckRevision: number | null = null;
  let asyncPresentCompletion: Promise<void> | null = null;
  let pendingViewRevision: number | null = null;
  let reentrantRetryQueued = false;
  // Publication is only a wake signal. The view must run its normal post-render callback to return wire credit.
  const retryPendingView = (revision: number, allowReentrantTurn = true): boolean => {
    if (!rustPendingAckRetry || disposed || pendingViewRevision !== revision || state?.revision !== revision ||
      asyncPresentedRevision !== revision || !reconcilePull?.retryNow) return false;
    const result = reconcilePull.retryNow();
    if (result === "presented" && pendingViewRevision === revision) pendingViewRevision = null;
    else if (result === "reentrant" && allowReentrantTurn && !reentrantRetryQueued) {
      reentrantRetryQueued = true;
      queueMicrotask(() => {
        reentrantRetryQueued = false;
        if (pendingViewRevision === revision) retryPendingView(revision, false);
      });
    }
    return true;
  };
  const traceWarmRenderer = (kind: string, revision: number | null) => {
    if (!warmAckTraceEnabled()) return;
    let pullPending: boolean | null = null;
    if (kind.startsWith("renderer-pull")) {
      try { pullPending = reconcilePull?.pending() ?? null; } catch { /* diagnostic only */ }
    }
    emitWarmAckTrace({ kind, revision, instance, presentEpoch: frameEpoch,
      asyncSubmissionRevision, asyncPresentedRevision, asyncAwaitingAckRevision, pullPending });
  };
  const displayPaced = rendererComparisonConfig.idleCadence === "display";
  let deterministicClock: number | null = (() => { const value = (window as unknown as { __benchDiagnosticClockMs?: unknown }).__benchDiagnosticClockMs; return typeof value === "number" ? value : null; })();
  let drawnClock: number | null = null;
  let backingW = 1, backingH = 1, dpr = 1;
  let appliedSize: { w: number; h: number; designW: number; designH: number; dpr: number } | null = null;
  let snapshot: DrawnSceneSnapshot | null = null;
  const fontPending = new Set<string>();
  const fontFailed = new Set<string>();
  const spinePending = new Set<string>();
  const spineFailed = new Set<string>();
  const spineClips = new Map<string, LoadedSpineClip>();
  const semanticFailures = new Map<string, string>();
  let semanticRows: Array<Record<string, unknown>> = [], semanticCandidate: Array<Record<string, unknown>> = [];
  const semanticEnabled = new URLSearchParams(window.location.search).has("paintDump");
  let staticBackground: { scenePath: string; url: string } | null = null;
  let handRaiseChrome: CanvasHandRaiseChrome | null = null;
  const handRaiseChromeKey = "client://hand-raise";
  let staticBackgroundReady: ((ready: boolean) => void) | undefined;
  let interaction!: ReturnType<typeof createCanvasInteractionRuntime>;
  const createdAt = performance.now();
  const effective = effectiveMirrorRenderSettings(mirrorSettings);
  const sliceSupported = effectiveMirrorQuality().tier === "very-low" && effective.shaderMode === "off" &&
    effective.particleMode === "off" && effective.staticBgEnabled && effective.spineMode === "static";

  setStageOwnsEffectPixels(true);

  function resize(): void {
    if (disposed) return;
    const box = { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) };
    const sized = stageBackingSize({ designW: box.w, designH: box.h, rect: host.getBoundingClientRect(), pixelRatio: stagePixelRatio() });
    backingW = sized.backingW; backingH = sized.backingH; dpr = sized.perDesignPx;
    startupEvent("renderer.resize", { backingWidth: backingW, backingHeight: backingH,
      dpr, designWidth: box.w, designHeight: box.h });
    if (!pixi) return;
    if (appliedSize?.w === backingW && appliedSize.h === backingH &&
        appliedSize.designW === box.w && appliedSize.designH === box.h && appliedSize.dpr === dpr) return;
    asyncPresentationSizeEpoch++;
    pixi.resize(backingW, backingH, 1, box.w, box.h);
    appliedSize = { w: backingW, h: backingH, designW: box.w, designH: box.h, dpr };
    if (presentedOnce && state && readiness === "ready") { pendingTextureSource = "resize"; scheduler.scheduleTexturePaint(); }
  }

  function commandIdentity(index: number, kind: number): string {
    if (build) for (const [id, range] of build.ranges) if (index >= range.start && index < range.paintEnd) return `${id}:${kind}:${index - range.start}`;
    return `${kind}:${index}`;
  }

  function streamedGlobalInto(world: MirrorState | null, id: string, out: number[]): boolean {
    const chain = []; let node = world?.nodes.get(id);
    while (node) { chain.push(node); node = node.parentId ? world?.nodes.get(node.parentId) : undefined; }
    if (!chain.length) return false;
    out.splice(0, 6, 1, 0, 0, 1, 0, 0);
    for (let i = chain.length - 1; i >= 0; i--) { const m = chain[i].transform; if (!m) continue; const [a,b,c,d,e,f]=out;
      out[0]=a*m[0]+c*m[1]; out[1]=b*m[0]+d*m[1]; out[2]=a*m[2]+c*m[3]; out[3]=b*m[2]+d*m[3]; out[4]=a*m[4]+c*m[5]+e; out[5]=b*m[4]+d*m[5]+f; }
    return true;
  }

  const visual = createCanvasVisualState({
    state: () => state, nodeOf: (id) => state?.nodes.get(id), hasChildren: (id) => snapshot?.build.order.childrenOf(id).length !== 0,
    paintOrder: () => snapshot?.paintOrder ?? null, hitEntries: () => snapshot?.hitEntries ?? [], capturedGlobal: (id) => snapshot?.capturedGlobals.get(id),
    cosmeticOffsetDy: (id) => interaction?.cosmeticOffsets.get(id)?.dy ?? 0,
    effectivelyVisible: (node) => interaction?.liveEffectivelyVisible(node) ?? node.visible,
    isLandingTarget: (id) => interaction?.handHolderIds.has(id) ?? false,
    onTransformArm: (id, at) => interaction?.noteTransformArmPose(id, at), onNodePresent: (node) => interaction?.noteNodePresent(node),
    onNodeRemoved: (id) => interaction?.noteNodeRemoved(id), onRewrite: () => interaction?.noteRewrite(), onFlights: () => {},
  }, { clockOriginMs: deterministicClock ?? performance.now(), now: () => deterministicClock ?? performance.now(), spreadAuditEnabled, noteIdlePeriod: () => {} });
  let lastSampleClock: number | null = null;
  const sampleVisual = (at: number) => { lastSampleClock = at; visual.sample(at); };
  const spreadDxByNode = visual.spreadDxByNode;
  const spreadFieldModeByNode = visual.spreadFieldModeByNode;
  const loop = visual.loop;
  interaction = createCanvasInteractionRuntime({
    state: () => state, snapshot: () => snapshot, now: () => deterministicClock ?? performance.now(), disposed: () => disposed,
    stage, stageScale: () => stage.getBoundingClientRect().width / Math.max(1, stage.clientWidth), designWidth: () => stage.clientWidth,
    spreadFactor: () => visual.spreadFactor, spreadDxByNode, spreadFieldModeByNode, loop: () => loop, streamedGlobalInto: visual.streamedGlobalInto,
    rebuildAndPaint: () => { if (state && readiness === "ready") paint(state, "local"); }, armAnimation: () => scheduler.armAnimation(performance.now()),
    builds: () => buildEpoch, paintedFrames: () => pixi?.stats.completedFrames ?? 0,
    sceneIndex: fast.sceneIndex, sceneIndexVerify: fast.verify,
  });
  const probeOwner = {};
  installHandPoseProbe(interaction.handPoses, probeOwner);
  installLandingLogProbe(visual.passiveLandingLogReport, probeOwner);
  if (spreadAuditEnabled) installSpreadAuditProbe(() => visual.spreadAuditReport()!, probeOwner);
  const passiveDeadline = (at: number): number => {
    const due = visual.idleDeadline(at, CANVAS_IDLE_ANIMATION_FPS, visual.idleStageNotBefore, displayPaced);
    return Number.isFinite(due) ? Math.max(due, visual.idleStageNotBefore) : due;
  };
  const idleStageBypass = (at: number) => {
    if (Number.isFinite(interaction.offsetRampDeadline)) return "offset" as const;
    if (loop.hasPerFrameDemand(at)) return "tween" as const;
    if (loop.nextDeadline(at) <= at + CANVAS_FRAME_PARK_SLOP_MS) return "settle" as const;
    return null;
  };
  const scheduler = createCanvasFrameScheduler({
    now: () => deterministicClock ?? performance.now(), state: () => state, disposed: () => disposed,
    revisionAtFrame: () => snapshot?.stateRevision ?? -1, idleAnimFps: () => CANVAS_IDLE_ANIMATION_FPS,
    cpuIncremental: retainedMode, displayPacedPassive: displayPaced,
    onFrameLifecycle: lifecycle ? (event, revision) => {
      if (event === "offered") lifecycle.begin("animation", revision, completedDraws());
      else if (event === "admitted") lifecycle.admit();
      else if (event === "sample-start") lifecycle.startPhase("sample");
      else if (event === "sample-end") lifecycle.endPhase("sample");
      else lifecycle.finish("skipped", completedDraws());
    } : undefined,
    deadlines: {
      offsetRampDeadline: () => interaction.offsetRampDeadline,
      loopDeadline: (at) => loop.nextDeadline(at), loopHasPerFrameDemand: (at) => loop.hasPerFrameDemand(at),
      trailDeadline: () => Number.POSITIVE_INFINITY,
      passiveDeadline, idleStageBypass,
      idleStageNotBefore: () => visual.idleStageNotBefore,
    },
    animation: {
      advanceOffsetRamps: interaction.advanceOffsetRamps,
      noteIdleStageMissingPassive: visual.noteIdleStageMissingPassive, noteIdleStageSkippedEarly: visual.noteIdleStageSkippedEarly,
      noteIdleStageAdmission: visual.noteIdleStageAdmission,
      sampleVisual,
      noteTrailFlightHeads() {}, tickTrails() {}, mergeTrailLatches() {}, advanceVisual: visual.advance, tickSpine() {},
      tryPatchAndPaint: (at) => tryRetainedPatch(at), runBuild: (next) => paint(next, "animation", retainedDecline), syncOverlay() {}, paintAction() {},
      settleLanding: () => {}, rebuildAndPaintTexture: () => state && readiness === "ready" ? deferredPaint(state) : false,
    },
  });
  function deferredPaint(next: MirrorState, requestedSource?: ProducerBuildSource): boolean {
    beginLocalFrame("texture");
    const source = requestedSource ?? (presentedOnce && committedSizeEpoch !== asyncPresentationSizeEpoch ? "resize" : pendingTextureSource);
    pendingTextureSource = "resource";
    if (!paint(next, source)) return false;
    const at = deterministicClock ?? performance.now();
    visual.advance(at);
    scheduler.armAnimation(at);
    return true;
  }
  const wakeForResource = () => { if (disposed) return; if (producerReasons) resourceEpoch++; pendingTextureSource = "resource"; scheduler.scheduleTexturePaint(); if (reconcilePull?.pending()) { traceWarmRenderer("renderer-pull-resource", state?.revision ?? null); reconcilePull.now(); } signalDiagnosticWake(); };
  const publishTextOutcome = () => {
    if (pixi) setRendererRuntimeStatus({ pixiText: pixi.textOutcomes() });
  };
  const scheduleRefinement = () => {
    if (refinementRaf !== null || disposed) return;
    refinementPending = true;
    refinementRaf = requestAnimationFrame(() => {
      refinementRaf = null;
      if (disposed || readiness !== "ready" || !pixi || !snapshot) return;
      refinementPending = false;
      beginLocalFrame("refinement");
      const phaseSubmissionId = rustExecutionPhaseMode
        ? producerReasons!.startRetained(snapshot.stateRevision, "present-only") : undefined;
      const profileIdentity = profile?.begin("present-only", snapshot.stateRevision);
      const phaseEvent = phaseSubmissionId === undefined ? undefined
        : (event: ProducerExecutorEvent) => producerReasons!.retainedEvent(phaseSubmissionId, event);
      try {
        const traceId = nextTraceFrame();
        const present = traceId === null ? () => pixi!.presentScene(phaseEvent, profileIdentity)
          : () => tracePixi(traceId, () => pixi!.presentScene(phaseEvent, profileIdentity));
        const result = lifecycle ? lifecycle.phase("pixi", present) : present();
if (isPromiseLike<PresentationResult>(result)) {
          void Promise.resolve(result).then((settled) => {
            if (disposed || !snapshot) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId,
              disposed ? "disposed" : "superseded"); return; }
            if (!settled.presented) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
              lifecycle?.finish("pending", completedDraws()); refinementPending = true; refinementFailure = settled.reason ?? "refinement presentation failed"; return; }
            frameEpoch++; lifecycle?.finish("completed", completedDraws()); refinementFailure = null; publishTextOutcome();
            if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "committed");
            if (startupEnabled) noteStartupReady(snapshot?.stateRevision ?? null);
          }).catch((error: unknown) => { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, disposed ? "disposed" : "failed");
            if (disposed) return; lifecycle?.finish("failed", completedDraws()); refinementPending = true; refinementFailure = error instanceof Error ? error.message : String(error); });
          return;
        }
        if (!result.presented) {
          if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
          lifecycle?.finish("pending", completedDraws());
          refinementPending = true;
          refinementFailure = result.reason ?? "glyph refinement presentation failed";
          return;
        }
        frameEpoch++;
        lifecycle?.finish("completed", completedDraws());
        refinementFailure = null;
        publishTextOutcome();
        if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "committed");
        if (startupEnabled) noteStartupReady(snapshot?.stateRevision ?? null);
      } catch (error) {
        if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
        lifecycle?.finish("failed", completedDraws());
        refinementPending = true;
        refinementFailure = error instanceof Error ? error.message : String(error);
      }
    });
  };

  function semanticText(input: NodePaintInput, record: OverlayRecord, insertionIndex: number): boolean {
    const node = input.node;
    ensureNodeFonts(node);
    // Both caches are independent switches (rustFastFlags umbrella semantics), so `fontReady` is shared by both
    // branches below rather than duplicated: with `fontCheckCache` off it is exactly `fonts.check(...)`, same as
    // before this round: `fontReady` is only ever called from inside an `if (fonts && ...)` guard.
    const fonts = document.fonts;
    const fontReady = (cssFont: string, text: string): boolean =>
      fontCheckCache ? fontCheckCache.check(cssFont, text, fontVersion, fast.verify) : fonts!.check(cssFont, text);

    if (textPrepCache) {
      const nodes = input.nodes ?? state?.nodes ?? new Map();
      const prepared = textPrepCache.resolve(node, nodes, fontVersion, textMode, fast.verify, (): PreparedText | TextPrepRefusal => {
        const resolved = resolveSemanticTextSpec(node, nodes);
        if ("refusal" in resolved) return resolved;
        if (!measureContext) return { refusal: "no-measure-context" };
        nativeLayouts++;
        return buildPreparedText(resolved, fontVersion, node.font!,
          (value) => measureContext.measureText(value).width,
          (cssFont) => { measureContext.font = cssFont; const sample = measureContext.measureText("Mg");
            return { ascent: sample.fontBoundingBoxAscent || sample.actualBoundingBoxAscent,
              descent: sample.fontBoundingBoxDescent || sample.actualBoundingBoxDescent }; });
      });
      if ("refusal" in prepared) { semanticFailures.set(node.id, prepared.refusal); return false; }
      if (fonts && !fontReady(prepared.spec.cssFont, prepared.spec.text) &&
          !fontPending.has(prepared.spec.cssFont) && !fontFailed.has(prepared.spec.cssFont)) {
        fontPending.add(prepared.spec.cssFont);
        void loadMirrorFont(fonts, prepared.spec.cssFont, prepared.spec.text, prepared.spec.family)
          .then(() => { if (!disposed) { fontVersion++; textLayoutCache.clear(); } })
          .catch(() => { if (!disposed) fontFailed.add(prepared.spec.cssFont); })
          .finally(() => { fontPending.delete(prepared.spec.cssFont); wakeForResource(); });
      }
      if (fontFailed.has(prepared.spec.cssFont)) { semanticFailures.set(node.id, "font-load"); return false; }
      const nativeParts = composePreparedTextRecords(prepared, node.id, insertionIndex, record, canvasBlend(node));
      const textStart = texts.length;
      if (textMode === "native" || nativeParts.length === 0) {
        texts.push(...nativeParts);
      } else {
        const carrierKey = `${node.id}:glyph`;
        const preparedGlyph = preparePixiGlyph(glyphRegistry, prepared.spec, prepared.layout, node.font!,
          record.transform, dpr, prepared.layoutKey, canvasBlend(node) === 0);
        texts.push({ ...nativeParts[0], key: carrierKey, transform: [...record.transform],
          text: prepared.spec.text, glyph: preparedGlyph.glyph, fallbackReason: preparedGlyph.fallbackReason,
          nativeFallback: nativeParts.map((part) => ({ ...part, alpha: 1, tint: 0xffffff, blend: 0 })) });
      }
      for (let i = textStart; i < texts.length; i++) {
        const text = texts[i];
        textOwners.set(text.key, node.id);
        const keys = textKeysByOwner.get(node.id) ?? [];
        keys.push(text.key);
        textKeysByOwner.set(node.id, keys);
      }
      return true;
    }

    // --- default path: unchanged from before rustFast WP3 (textPrepCache off = byte-identical behavior) -------
    const scene = resolveSceneInfo(node.id, input.nodes ?? state?.nodes ?? new Map());
    const decls = resolveTextScaleDecls(scene?.file ?? null, scene?.relPath ?? null);
    let spec = resolveTextSpec(node, decls);
    if (!spec || !node.font) { semanticFailures.set(node.id, !spec ? "unresolved-text" : "no-font"); return false; }
    let spans: readonly TextSpan[] | undefined;
    if (spec.refusal === "rich") {
      const parsed = parseSimpleRich(spec.text, { color: (value) => value });
      if (!parsed.ok) { semanticFailures.set(node.id, `rich:${parsed.refusal}`); return false; }
      const plain = resolveTextSpec({ ...node, richText: false, text: { ...node.text!, text: parsed.value.text } }, decls);
      if (!plain || plain.refusal) { semanticFailures.set(node.id, `rich:${plain?.refusal ?? "post-parse"}`); return false; }
      spec = parsed.value.align === null ? plain : { ...plain, align: parsed.value.align };
      spans = parsed.value.spans.length ? parsed.value.spans : undefined;
    }
    if (spec.refusal || !measureContext) { semanticFailures.set(node.id, spec.refusal ?? "no-measure-context"); return false; }
    if (fonts && !fontReady(spec.cssFont, spec.text) && !fontPending.has(spec.cssFont) && !fontFailed.has(spec.cssFont)) {
      fontPending.add(spec.cssFont);
      void loadMirrorFont(fonts, spec.cssFont, spec.text, spec.family)
        .then(() => { if (!disposed) { fontVersion++; textLayoutCache.clear(); } })
        .catch(() => { if (!disposed) fontFailed.add(spec.cssFont); })
        .finally(() => { fontPending.delete(spec.cssFont); wakeForResource(); });
    }
    if (fontFailed.has(spec.cssFont)) { semanticFailures.set(node.id, "font-load"); return false; }
    const layoutKey = JSON.stringify([fontVersion, node.font, spec, spans]);
    let prepared = retainedMode ? textLayoutCache.get(node.id) : undefined;
    if (prepared?.key !== layoutKey) {
      measureContext.font = spec.cssFont;
      const metricSample = measureContext.measureText("Mg");
      const metrics = { ascent: metricSample.fontBoundingBoxAscent || metricSample.actualBoundingBoxAscent,
        descent: metricSample.fontBoundingBoxDescent || metricSample.actualBoundingBoxDescent };
      const layout = layoutText(spec, (value) => measureContext.measureText(value).width, spans);
      prepared = { key: layoutKey, layout, metrics };
      if (retainedMode) textLayoutCache.set(node.id, prepared);
      nativeLayouts++;
      if (textLayoutCache.size > 512) textLayoutCache.delete(textLayoutCache.keys().next().value!);
    }
    const { metrics, layout } = prepared;
    const shadow = spec.shadow ? pixiShadowColor(spec.shadow.color) : null;
    if (spec.shadow && !shadow) { semanticFailures.set(node.id, "invalid-shadow-color"); return false; }
    const scale = spec.blockScale;
    const nativeParts: PixiTextRecord[] = [];
    for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
      const line = layout.lines[lineIndex];
      const originCorrection=nativeTextOriginCorrection(spec.pitchPx,spec.outlinePx,metrics);
      const y = (1 - scale) * spec.boxH / 2 + (line.y + originCorrection.y) * scale;
      const m = record.transform;
      const parts = line.runs?.length ? line.runs : [{ text: line.text, x: line.x, color: null }];
      for (let runIndex = 0; runIndex < parts.length; runIndex++) {
      const part = parts[runIndex]; const x = (1 - scale) * spec.boxW / 2 + (part.x + originCorrection.x) * scale;
      const transform = [m[0]*scale,m[1]*scale,m[2]*scale,m[3]*scale,m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
      nativeParts.push({
      key: `${node.id}:${lineIndex}:${runIndex}`, insertionIndex, text: part.text, transform,
      labelId: node.id,
      resourceRevision: `${fontVersion}:${JSON.stringify(node.font)}`,
      style: {
        fontFamily: spec.family, fontSize: spec.fontPx,
        fontStyle: (node.font.style || "normal") as "normal" | "italic" | "oblique",
        fontWeight: (node.font.weight || "normal") as "normal", fill: part.color ?? spec.color,
        align: "left", wordWrap: false, lineHeight: spec.pitchPx,
        stroke: spec.outlineColor && spec.outlinePx > 0 ? { color: spec.outlineColor, width: spec.outlinePx } : undefined,
        dropShadow: spec.shadow && shadow ? { color: shadow.color, alpha: shadow.alpha, angle: Math.atan2(spec.shadow.dy, spec.shadow.dx), distance: Math.hypot(spec.shadow.dx, spec.shadow.dy), blur: 0 } : undefined,
      },
      alpha: record.opacity,
      blend: canvasBlend(node),
      tint: (Math.round(Math.max(0, Math.min(1, record.tintR)) * 255) << 16) |
        (Math.round(Math.max(0, Math.min(1, record.tintG)) * 255) << 8) |
        Math.round(Math.max(0, Math.min(1, record.tintB)) * 255),
    });
      }
    }
    const textStart = texts.length;
    if (textMode === "native" || nativeParts.length === 0) {
      texts.push(...nativeParts);
    } else {
      const carrierKey = `${node.id}:glyph`;
      const preparedGlyph = preparePixiGlyph(glyphRegistry, spec, layout, node.font,
        record.transform, dpr, layoutKey, canvasBlend(node) === 0);
      texts.push({ ...nativeParts[0], key: carrierKey, transform: [...record.transform],
        text: spec.text, glyph: preparedGlyph.glyph, fallbackReason: preparedGlyph.fallbackReason,
        nativeFallback: nativeParts.map((part) => ({ ...part, alpha: 1, tint: 0xffffff, blend: 0 })) });
    }
    for (let i = textStart; i < texts.length; i++) {
      const text = texts[i];
      textOwners.set(text.key, node.id);
      const keys = textKeysByOwner.get(node.id) ?? [];
      keys.push(text.key);
      textKeysByOwner.set(node.id, keys);
    }
    return true;
  }

  // `target` is the list being built: the live one, or a held-override verification shadow.
  function semanticOverlay(input: NodePaintInput, record: OverlayRecord, _insertionIndex?: number, target = list): void {
    if (record.kind !== "spine") return;
    const url = spineClipUrl(input.node, { still: true });
    if (!url) { semanticFailures.set(input.node.id, "unresolved-spine-still"); return; }
    const clip = spineClips.get(url);
    if (!clip && !spinePending.has(url) && !spineFailed.has(url)) {
      spinePending.add(url);
      void loadSpineClip(url, { stillImg: true }).then((loaded) => {
        if (disposed) return;
        if (!loaded || !loaded.stillUrl || loaded.frames.length !== 1) { spineFailed.add(url); return; }
        loaded.retain(); spineClips.set(url, loaded);
      }).catch(() => { if (!disposed) spineFailed.add(url); })
        .finally(() => { spinePending.delete(url); wakeForResource(); });
      return;
    }
    if (spineFailed.has(url)) { semanticFailures.set(input.node.id, "spine-load"); return; }
    if (!clip?.stillUrl || clip.frames.length !== 1) return;
    const frame = clip.frames[0]; const scale = clip.canvasWidth > 0 && clip.localWidth > 0 ? clip.localWidth / clip.canvasWidth : 1;
    const q = scratch.quad; const m = record.transform; const tx = clip.localX + frame.offsetX * scale; const ty = clip.localY + frame.offsetY * scale;
    q.m[0]=m[0]*scale; q.m[1]=m[1]*scale; q.m[2]=m[2]*scale; q.m[3]=m[3]*scale;
    q.m[4]=m[0]*tx+m[2]*ty+m[4]; q.m[5]=m[1]*tx+m[3]*ty+m[5]; q.w=frame.width; q.h=frame.height;
    q.srcX=0; q.srcY=0; q.srcW=frame.width; q.srcH=frame.height; q.a=record.opacity;
    q.r=record.tintR*record.opacity; q.g=record.tintG*record.opacity; q.b=record.tintB*record.opacity;
    q.blend=canvasBlend(input.node); q.flipH=false; q.flipV=false; q.hasColorMatrix=false; target.pushQuad(q, clip.stillUrl);
  }

  // See `staticBgSkipRootMemo` above for why this is a per-node-object memo rather than a changedIds-driven
  // candidate set. Under `fast.verify` a hit is recomputed and compared rather than trusted, so a stale entry
  // left by a since-moved ancestor would show up as a counted mismatch instead of a silent wrong skip.
  function isStaticBackgroundSkipRoot(node: MirrorNode, nodes: ReadonlyMap<string, MirrorNode>): boolean {
    const direct = () => staticBgTargetPathOf(node, nodes) !== null && isStaticBackgroundSuppressibleRoot(node, nodes);
    if (!staticBgSkipRootMemo) return direct();
    const cached = staticBgSkipRootMemo.get(node);
    if (cached !== undefined && !fast.verify) return cached;
    const computed = direct();
    if (fast.verify && cached !== undefined && cached !== computed) sceneIndexVerifyMismatches++;
    staticBgSkipRootMemo.set(node, computed);
    return computed;
  }
  // The hand-raise chrome painter, shared by full builds and the held-override verification shadow.
  const handRaiseChromePainter: NonNullable<BuildDrawListOptions["handRaiseChrome"]> = {
    emit(input, chromeScratch, sink) {
      const chrome = handRaiseChrome!;
      pixi?.bindPixelTexture(handRaiseChromeKey, chrome.source, chrome.revision);
      const q = chromeScratch.quad;
      const designWidth = input.renderWidthOverride && input.renderWidthOverride > 0
        ? input.renderWidthOverride : (input.node.localRect?.width ?? MIRROR_DESIGN_WIDTH);
      q.m.set(handRaiseChromeMatrix(input.global, designWidth, chrome));
      q.w=chrome.width; q.h=chrome.height; q.srcX=0; q.srcY=0; q.srcW=chrome.source.width; q.srcH=chrome.source.height;
      q.r=input.ownOpacity; q.g=input.ownOpacity; q.b=input.ownOpacity; q.a=input.ownOpacity;
      q.blend=0; q.flipH=false; q.flipV=false; q.hasColorMatrix=false;
      sink.quad(q, handRaiseChromeKey);
      return 1;
    },
  };

  function paint(next: MirrorState, source: ProducerBuildSource, decline = "direct-build"): boolean {
    const profileIdentity = profile?.begin("full-build", next.revision, ++profileBuildAttempts);
    const traceId = nextTraceFrame();
    // Rust presentation is asynchronous. Keep one scene in flight; newer state remains in `state` and is
    // reconciled after this presentation settles, while repeated scheduler wakeups cannot invalidate its ticket.
    if (backend === "rust" && asyncSubmissionRevision !== null) {
      if (profileIdentity) profile!.outcome(profileIdentity, "superseded", "full-build-deferred-in-flight");
      producerReasons?.noteNonBuild("full-build-deferred-in-flight");
      return false;
    }
    if (startupEnabled && ++startupPrepares <= 5) startupEvent("renderer.framePrepare", { revision: next.revision,
      pending: pixi?.stats.resourcePending ?? null, failed: pixi?.stats.textureFailures ?? null });
    const candidateRevision = next.revision;
    const paintTicket = asyncPresentation.begin(candidateRevision);
    const sizeEpoch = asyncPresentationSizeEpoch;
    const candidateClock = deterministicClock;
    asyncPresentedRevision = null;
    asyncSubmissionRevision = null;
    beginLocalFrame("local");
    lifecycle?.startPhase("prepare");
    if (traceId !== null) traceStamp!(`cc:frame:${traceId}:couch:prepare:start`);
    retainedValid = false;
    // rustHeldOverridePatch: builds that run while overrides are applied or banked, by the decline that sent them.
    if (fast.heldOverridePatch && (visual.transformOverrides.size || committedOverrides?.size))
      heldOverrideDeclines[decline] = (heldOverrideDeclines[decline] ?? 0) + 1;
    noteHeldEvent(() => `build r${next.revision} ${source}/${decline} overrides=[${[...visual.transformOverrides.keys()].join(",")}]`);
    committedOverrides = null;
    paintGeneration++;
    texts.length = 0;
    textOwners.clear();
    textKeysByOwner.clear();
    semanticFailures.clear();
    const capturedGlobals = new Map(); const captureIds = new Set<string>(); interaction.collectCaptureIds(captureIds); visual.collectLandingCaptureIds(captureIds);
    visual.prepareBuild(next); interaction.prepareBuild(); spreadDxByNode.clear(); spreadFieldModeByNode.clear();
    list.reset();
    let skipRoots = new Set<string>();
    if (staticBackground) {
      const q = scratch.quad; q.m.set([1,0,0,1,(stage.clientWidth-2520)/2,0]); q.w=2520; q.h=1080; q.srcX=0; q.srcY=0; q.srcW=2520; q.srcH=1080;
      q.r=1; q.g=1; q.b=1; q.a=1; q.blend=0; q.flipH=false; q.flipV=false; q.hasColorMatrix=false; list.pushQuad(q, staticBackground.url);
      // Every node-map change bumps the revision, so one (map, revision) answers the scan for every rebuild.
      if (staticSkipMemo?.nodes === next.nodes && staticSkipMemo.revision === next.revision &&
        staticSkipMemo.background === staticBackground) { skipRoots = staticSkipMemo.roots; staticSkipRootReuses++; }
      else {
        for (const node of next.nodes.values())
          if (fast.sceneIndex ? isStaticBackgroundSkipRoot(node, next.nodes)
            : staticBgTargetPathOf(node, next.nodes) !== null && isStaticBackgroundSuppressibleRoot(node, next.nodes))
            skipRoots.add(node.id);
        if (fast.snapshotReuse) staticSkipMemo = { nodes: next.nodes, revision: next.revision, background: staticBackground, roots: skipRoots };
      }
    }
    lifecycle?.endPhase("prepare");
    if (traceId !== null) traceStamp!(`cc:frame:${traceId}:couch:prepare:end`);
    const buildScene = () => buildDrawList(next, list, { resetList: false, scratch, paintOrderCache,
      spreadAudit: visual.spreadAudit,
      profilePhase: profileIdentity ? (phase, run) => profile!.span(profileIdentity, `couch.draw-${phase}`, run) : undefined,
      structureReuse: paintOrderReuse, hitMemo, skipRoots,
      skipHiddenHitCandidates: rustSkipHiddenHitCandidates,
      hiddenSubtreeMemo: hiddenMemo, hiddenSubtreeMemoVerify: fast.verify,
      hiddenWalkDiagnostic: hiddenWalkMode ? (summary) => {
        if (hiddenWalkRows.length < 1024) hiddenWalkRows.push({ buildId: producerBuilds + 1, revision: next.revision, summary });
        else hiddenWalkOverflow = true;
      } : undefined,
      handRaiseChrome: handRaiseChrome ? handRaiseChromePainter : null,
      textureSize: (url) => pixi?.textureSize(url) ?? null,
      semanticBegin: () => { semanticCandidate = []; },
      semanticNode: (input, cls, start, end) => {
        if (pixi && cls === "canvas" && !input.hidden && input.node.shaderId == null && !isShaderInputNode(input.node) && input.node.textureUrl && !pixi.textureSize(input.node.textureUrl)) pixi.prefetch(input.node.textureUrl);
        if (!semanticEnabled || deterministicClock === null) return;
        semanticCandidate.push({ order: input.order, id: input.node.id, type: input.node.nodeType, class: cls,
          transform: [...input.global], rect: input.node.localRect, alpha: input.ownOpacity,
          tint: [input.tintR,input.tintG,input.tintB], commands: cls === "canvas" ? end - start : null, texture: input.node.textureUrl,
          decodedSize: input.node.textureUrl ? pixi?.textureSize(input.node.textureUrl) ?? null : null,
          region: input.node.textureRegion, flip: [input.node.textureFlipH,input.node.textureFlipV], nine: input.node.ninePatchMargins, line: input.node.linePoints,
          clip: [input.node.clipContents,input.node.clipChildren], text: input.node.text, font: input.node.font,
          outline: input.node.outline, shadow: input.node.shadow });
        if (cls === "canvas") semanticCandidate[semanticCandidate.length - 1].primitives = emittedPrimitiveRows(list, start, end);
        if (input.node.text) semanticCandidate[semanticCandidate.length - 1].placedText = semanticTextLayout(input.node, input.nodes!, measureContext);
      },
      spreadFactor: visual.spreadFactor,
      spreadRegistry: visual.spreadRegistry, spreadDxOut: spreadDxByNode, spreadFieldModeOut: spreadFieldModeByNode,
      transformOverrides: visual.transformOverrides.size ? visual.transformOverrides : null,
      alphaOverrides: visual.alphaOverrides.size ? visual.alphaOverrides : null,
      localAnims: visual.localAnims.size ? visual.localAnims : null,
      frameSubstitutes: visual.frameSubstitutes.size ? visual.frameSubstitutes : null,
      viewScaleEnv: visual.viewScaleEnv, tipScaleEnv: visual.tipScaleEnv, pinnedLocals: visual.pinnedLocals,
      captureGlobals: captureIds.size ? { ids: captureIds, out: capturedGlobals } : null,
      cosmeticOffsets: interaction.cosmeticOffsets, semanticText, semanticOverlay, assert: false });
    // rustHeldOverridePatch: the overrides this build applies, by value, banked when its frame publishes.
    const appliedOverrides = fast.heldOverridePatch ? copyTransformOverrides(visual.transformOverrides) : null;
const producerStarted = rustPhaseTimingMode || producerReasonMode ? performance.now() : 0;
    const tracedBuild = traceId === null ? buildScene : () => tracePhase(traceId, "build", buildScene);
    const phaseBuildId = producerBuilds + 1;
    if (rustExecutionPhaseMode) rustExecutionStamp(`cc:couch-exec:build:${phaseBuildId}:start`);
    try { build = profileIdentity ? profile!.span(profileIdentity, "couch.build-draw-list", () => lifecycle ? lifecycle.phase("build", tracedBuild) : tracedBuild())
      : lifecycle ? lifecycle.phase("build", tracedBuild) : tracedBuild(); }
    finally { if (rustExecutionPhaseMode) rustExecutionStamp(`cc:couch-exec:build:${phaseBuildId}:end`); }
    const producerElapsed = rustPhaseTimingMode || producerReasonMode ? performance.now() - producerStarted : 0;
    if (rustPhaseTimingMode) producerBuildMs += producerElapsed;
    producerBuilds++;
    const buildId = producerReasons?.add({ source, decline, sceneRevision: next.revision,
      committedRevision: snapshot?.stateRevision ?? null, changedIds: next.changedIds.size,
      sceneRewrite: next.sceneRewrite, sampledVisual: visual.frameSampleMask !== 0 || visual.transformOverrides.size > 0,
      sizeChanged: committedSizeEpoch !== asyncPresentationSizeEpoch,
      fontChanged: committedFontVersion !== fontVersion,
      textureCountChanged: committedTextureCount !== (pixi?.stats.textures ?? -1),
      resourcesPending: fontPending.size > 0 || spinePending.size > 0 || (pixi?.stats.resourcePending ?? 0) > 0,
      elapsedMs: producerElapsed,
      sampleClock: lastSampleClock ?? candidateClock, buildEpoch, sizeEpoch: asyncPresentationSizeEpoch,
      fontEpoch: fontVersion, textureEpoch: pixi?.stats.textureLoads ?? 0, resourceEpoch,
      frameSampleMask: visual.frameSampleMask,
      windowPhase: typeof (window as unknown as { __benchWindowMark?: unknown }).__benchWindowMark === "number"
        ? (window as unknown as { __benchWindowMark: number }).__benchWindowMark : null });
    const frameBuild = build!;
    // A pristine committed copy of this same live map at this revision is the map a fresh copy would produce:
    // only applySceneDelta edits the live map, and it always bumps the revision. A build's paint order and hit
    // list are never edited after it returns, so snapshot reuse publishes them without copies.
    const reuseNodes = fast.snapshotReuse && snapshotNodesSource === next.nodes && snapshot?.stateRevision === next.revision;
    if (reuseNodes) snapshotNodeReuses++;
    const candidateNodes = reuseNodes ? snapshot!.scene.nodes : new Map(next.nodes);
    const candidateOrderedIds = fast.snapshotReuse ? frameBuild.order.ids : frameBuild.order.ids.slice();
    const interactionCandidate = interaction.captureBuild();
    const landingCandidate = visual.captureLandingPresentation(next, lastSampleClock ?? candidateClock ?? performance.now(),
      capturedGlobals, interactionCandidate.cosmeticOffsets);
    const candidateLandingGeneration = visual.landingGeneration;
    if (profileIdentity) { profile!.outcome(profileIdentity, "built"); profile!.counter(profileIdentity, { commands: list.count, textRecords: texts.length }); }
    if (backend !== "rust" && (fontFailed.size > 0 || spineFailed.size > 0 || semanticFailures.size > 0)) {
      if (profileIdentity) profile!.outcome(profileIdentity, "failed", "resource or semantic failure");
      if (buildId !== undefined) {
        if (fontFailed.size || spineFailed.size) producerReasons!.finish(buildId, "stopped-resource-failed",
          fontFailed.size ? "font" : "spine", fontFailed.size ? [...fontFailed] : [...spineFailed]);
        else producerReasons!.finish(buildId, "failed");
      }
      publishStatus("failed", [...semanticFailures.values()][0] ?? "A Pixi text or spine resource failed");
      lifecycle?.finish("failed", completedDraws());
      return false;
    }
    if (fontPending.size > 0 || spinePending.size > 0) {
      if (profileIdentity) profile!.outcome(profileIdentity, "refused", "font or spine pending");
      if (buildId !== undefined) producerReasons!.finish(buildId,
        fontPending.size ? "stopped-font-pending" : "stopped-spine-pending",
        fontPending.size ? "font" : "spine", fontPending.size ? [...fontPending] : [...spinePending]);
      lifecycle?.finish("pending", completedDraws()); return false;
    }
    let candidate: ReturnType<typeof createRetainedPixiComposition> | null = null;
    let submitted: unknown;
    try {
      if (retainedMode) {
        if (rustExecutionPhaseMode) rustExecutionStamp(`cc:couch-exec:composition:${buildId ?? 0}:start`);
        try { const compose = () => createRetainedPixiComposition(list, frameBuild, texts, textOwners, spreadDxByNode,
          backend === "rust" ? { includeStaticPixelCaches: !rustOmitStaticPixelCaches,
            onStaticAdmission: rustStaticAdmissionPhaseMode
              ? (edge) => console.timeStamp(`cc:couch-exec:static-admission:${buildId ?? 0}:${edge}`)
              : undefined, ...compositionLaziness } : undefined);
          candidate = profileIdentity ? profile!.span(profileIdentity, "couch.retained-composition", compose) : compose(); }
        finally { if (rustExecutionPhaseMode) rustExecutionStamp(`cc:couch-exec:composition:${buildId ?? 0}:end`); }
      }
      const submit = () => retainedMode ? pixi?.admitScene(list, texts, candidate!.plan,
        buildId === undefined ? undefined : (event) => producerReasons?.event(buildId, event), profileIdentity) : pixi?.render(list, texts, profileIdentity);
      if (startupEnabled && ++startupSubmits <= 5) startupEvent("renderer.frameSubmit", { revision: next.revision,
        commands: list.count, textRecords: texts.length,
        pending: pixi?.stats.resourcePending ?? null, failed: pixi?.stats.textureFailures ?? null });
      const tracedSubmit = traceId === null ? submit : () => tracePixi(traceId, submit);
      submitted = lifecycle ? lifecycle.phase("pixi", tracedSubmit) : tracedSubmit();
      if (isPromiseLike<unknown>(submitted)) {
        asyncSubmissionRevision = candidateRevision;
        asyncPresentCompletion = Promise.resolve(submitted).then((result) => {
          if (!asyncPresentation.current(paintTicket)) {
            if (profileIdentity) profile!.outcome(profileIdentity, "superseded", disposed ? "disposed" : "newer presentation ticket");
            if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, disposed ? "disposed" : "superseded");
            return;
          }
          if (state?.revision !== candidateRevision || asyncPresentationSizeEpoch !== sizeEpoch ||
            visual.landingGeneration !== candidateLandingGeneration) {
            if (profileIdentity) profile!.outcome(profileIdentity, "superseded", "scene revision or size changed");
            if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, "superseded");
            producerReasons?.noteNonBuild("full-presentation-stale");
            if (asyncSubmissionRevision === candidateRevision) asyncSubmissionRevision = null;
            retainedValid = false; committedOverrides = null;
            if (asyncAwaitingAckRevision === candidateRevision) asyncAwaitingAckRevision = null;
            scheduler.scheduleTexturePaint();
            return;
          }
          if (!resultPresented(result)) {
            if (profileIdentity) profile!.outcome(profileIdentity, "refused", "executor did not complete");
            if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, "refused");
            producerReasons?.noteNonBuild("full-presentation-refused");
            const reason = result && typeof result === "object" ? (result as PresentationResult).reason : undefined;
            if (asyncSubmissionRevision === candidateRevision) asyncSubmissionRevision = null;
            if (reason && !/pending|resource/i.test(reason)) publishStatus("failed", reason);
            lifecycle?.finish("pending", completedDraws());
            return;
          }
          publishCommittedFrame(result as PresentationResult);
          if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, "committed");
          next.changedIds.clear();
          next.sceneRewrite = false;
          asyncPresentedRevision = candidateRevision;
          asyncSubmissionRevision = null;
          traceWarmRenderer("renderer-async-published", candidateRevision);
          if (retryPendingView(candidateRevision)) {
            if (asyncAwaitingAckRevision === candidateRevision) asyncAwaitingAckRevision = null;
          } else if (asyncAwaitingAckRevision === candidateRevision && reconcilePull) {
            asyncAwaitingAckRevision = null;
            traceWarmRenderer("renderer-pull", candidateRevision);
            reconcilePull.now();
          }
          else scheduler.armAnimation(deterministicClock ?? performance.now());
          startupCompletionHook?.();
        }).catch((error: unknown) => {
          if (profileIdentity) profile!.outcome(profileIdentity, "failed", error instanceof Error ? error.message : String(error));
          if (!asyncPresentation.current(paintTicket)) {
            if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, disposed ? "disposed" : "superseded");
            return;
          }
          if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, "failed");
          producerReasons?.noteNonBuild("full-presentation-error");
          if (asyncSubmissionRevision === candidateRevision) asyncSubmissionRevision = null;
          publishStatus("failed", error instanceof Error ? error.message : String(error));
          lifecycle?.finish("failed", completedDraws());
        });
        lifecycle?.finish("pending", completedDraws());
        return false;
      }
      if (!resultPresented(submitted)) {
        if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, "refused");
        if (backend !== "rust" && (pixi?.stats.textureFailures ?? 0) > 0) publishStatus("failed", pixi?.textureFailureDetails().join(" | ") || "Pixi texture failed");
        else if ((pixi?.stats.blockedRefusedFrames ?? 0) > 0) publishStatus("failed", "Pixi refused a scene drawing command");
        lifecycle?.finish("pending", completedDraws());
        return false;
      }
    } catch (error) {
      if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, "failed");
      publishStatus("failed", error instanceof Error ? error.message : String(error));
      lifecycle?.finish("failed", completedDraws());
      return false;
    }
    try {
      const published = publishCommittedFrame(submitted as PresentationResult | boolean | undefined);
      if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, "committed");
      return published;
    } catch (error) {
      if (buildId !== undefined) producerReasons?.finishIfOpen(buildId, "failed");
      throw error;
    }
    function publishCommittedFrame(presentation: PresentationResult | boolean | undefined): boolean {
    lifecycle?.startPhase("publish");
    if (!presentedOnce) { presentedOnce = true; publishStatus("ready"); }
    retained = candidate;
    retainedValid = retainedMode;
    snapshotNodesSource = fast.snapshotReuse ? next.nodes : null;
    committedSizeEpoch = asyncPresentationSizeEpoch;
    committedFontVersion = fontVersion;
    committedTextureCount = pixi?.stats.textures ?? -1;
    retainedDiagnosticFields.clear();
    buildEpoch++;
    frameEpoch++;
    traceWarmRenderer("renderer-published", candidateRevision);
    const committedSnapshot: DrawnSceneSnapshot = { scene: { nodes: candidateNodes, orderedIds: candidateOrderedIds }, build: frameBuild, paintOrder: frameBuild.order,
      hitEntries: fast.snapshotReuse ? frameBuild.hitEntries : frameBuild.hitEntries.slice(), capturedGlobals, buildEpoch, stateRevision: candidateRevision,
      inputEpoch: 0, resourceEpoch: 0, textureReadyEpoch: String(pixi?.stats.textures ?? 0),
      derived: { wireGraph: {}, wireHitsByNode: new Map(), wireOverlayOrders: new Set() } };
    snapshot = committedSnapshot;
    if (startupEnabled && ++startupCompletes <= 5) startupEvent("renderer.frameComplete", { revision: candidateRevision,
      buildEpoch, presentEpoch: frameEpoch, completedFrames: pixi?.stats.completedFrames ?? null });
    semanticRows = semanticCandidate;
    drawnClock = candidateClock;
    signalDiagnosticWake();
    interaction.publishBuild(committedSnapshot, interactionCandidate);
    landingCandidate.publish();
    refinementPending = refinementRaf !== null;
    refinementFailure = null;
    publishTextOutcome();
    visual.bankAppliedAlphas();
    committedOverrides = appliedOverrides;
    staticBackgroundReady?.(true); staticBackgroundReady = undefined;
    if (startupEnabled) noteStartupReady(candidateRevision);
    lifecycle?.endPhase("publish");
    lifecycle?.finish("completed", completedDraws());
    if (contentTrace) console.timeStamp(`cc:content:${candidateRevision}:${buildEpoch}:${frameEpoch}`);
    if (startupCommitHook) noteStartupCommit(candidateRevision, presentation, { revision: committedSnapshot.stateRevision,
      buildEpoch: committedSnapshot.buildEpoch, presentEpoch: frameEpoch, clock: drawnClock });
    startupCompletionHook?.();
    return true;
    }
  }

  function publishRetainedPatch(patch: RetainedPixiPatch, at: number, wire?: MirrorState,
    presentation?: PresentationResult, landingCandidate?: LandingPresentation): void {
    lifecycle?.startPhase("publish");
    const previous = snapshot!;
    for (const { entry, matrix, gameMatrix } of patch.hits) {
      entry.mFinal = matrix;
      if (gameMatrix) entry.mGame = gameMatrix;
    }
    retained!.commit(patch);
    for (const item of patch.primitives) if (item.alpha !== undefined || item.source !== undefined)
      retainedDiagnosticFields.set(item.id, { ...retainedDiagnosticFields.get(item.id), alpha: item.alpha, source: item.source });
    frameEpoch++;
    traceWarmRenderer("renderer-published", wire?.revision ?? previous.stateRevision);
    if (wire) {
      const nodes = previous.scene.nodes as Map<string, MirrorNode>;
      if (wire.changedIds.size) snapshotNodesSource = null;
      for (const id of wire.changedIds) {
        const node = wire.nodes.get(id);
        if (node) nodes.set(id, node); else nodes.delete(id);
      }
    }
    snapshot = { ...previous, stateRevision: wire?.revision ?? previous.stateRevision };
    interaction.publishPatch(previous, snapshot);
    landingCandidate?.publish();
    refinementPending = refinementRaf !== null;
    refinementFailure = null;
    publishTextOutcome();
    if (startupEnabled) noteStartupReady(snapshot.stateRevision);
    drawnClock = at;
    signalDiagnosticWake();
    noteHeldEvent(() => `patch r${snapshot!.stateRevision} held=${heldPatches.has(patch) ? 1 : 0} wire=${wire?.changedIds.size ?? 0} ` +
      `primitives=${patch.primitives.length} alphas=${patch.primitives.filter((item) => item.alpha !== undefined).length} groups=${patch.groups.length}`);
    if (heldPatches.has(patch)) { heldOverridePatches++; const inputs = heldPatches.get(patch); if (inputs) verifyHeldOverridePatch(inputs); }
    retainedPatches++;
    retainedPatchObjects += patch.primitives.length;
    lifecycle?.endPhase("publish");
    lifecycle?.finish("completed", completedDraws());
    if (contentTrace) console.timeStamp(`cc:content:${snapshot.stateRevision}:${snapshot.buildEpoch}:${frameEpoch}`);
    if (startupCommitHook) noteStartupCommit(snapshot.stateRevision, presentation, { revision: snapshot.stateRevision,
      buildEpoch: snapshot.buildEpoch, presentEpoch: frameEpoch, clock: drawnClock });
    startupCompletionHook?.();
  }

  function submitRetainedPatch(patch: RetainedPixiPatch, traceId: string | null) {
    const mode = patch.primitives.length || patch.groups.length ? "scene-patch" : "present-only";
    const profileIdentity = profile?.begin(mode === "scene-patch" ? "retained-patch" : "present-only", state?.revision);
    const phaseSubmissionId = rustExecutionPhaseMode
      ? producerReasons!.startRetained(state?.revision ?? null, mode) : undefined;
    const phaseEvent = phaseSubmissionId === undefined ? undefined
      : (event: ProducerExecutorEvent) => producerReasons!.retainedEvent(phaseSubmissionId, event);
    const submit = () => patch.primitives.length || patch.groups.length
      ? pixi!.patchScene({ primitives: patch.primitives, groups: patch.groups }, phaseEvent, profileIdentity) : pixi!.presentScene(phaseEvent, profileIdentity);
    const tracedSubmit = traceId === null ? submit : () => tracePixi(traceId, submit);
    try { return { result: lifecycle ? lifecycle.phase("pixi", tracedSubmit) : tracedSubmit(), phaseSubmissionId }; }
    catch (error) {
      if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
      throw error;
    }
  }

  function trackAsyncRetainedPatch(result: Promise<PresentationResult>, patch: RetainedPixiPatch, at: number,
    wire?: MirrorState, phaseSubmissionId?: number, landingCandidate?: LandingPresentation): void {
    const revision = wire?.revision ?? state?.revision;
    if (revision === undefined || revision === null || asyncSubmissionRevision !== null) {
      if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "superseded");
      return;
    }
    const ticket = asyncPresentation.begin(revision);
    const sizeEpoch = asyncPresentationSizeEpoch;
    const candidateLandingGeneration = visual.landingGeneration;
    if (rustDiagnosticMode) retainedAsyncSubmitted++;
    asyncSubmissionRevision = revision;
    asyncPresentCompletion = Promise.resolve(result).then((outcome) => {
      if (!asyncPresentation.current(ticket)) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(
        phaseSubmissionId, disposed ? "disposed" : "superseded"); return; }
      if (state?.revision !== revision || asyncPresentationSizeEpoch !== sizeEpoch ||
        visual.landingGeneration !== candidateLandingGeneration) {
        if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "superseded");
        producerReasons?.noteNonBuild("retained-presentation-stale");
        if (asyncSubmissionRevision === revision) asyncSubmissionRevision = null;
        retainedValid = false; committedOverrides = null;
        if (asyncAwaitingAckRevision === revision) asyncAwaitingAckRevision = null;
        scheduler.scheduleTexturePaint();
        return;
      }
      if (!resultPresented(outcome)) {
        if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
        producerReasons?.noteNonBuild("retained-presentation-refused");
        retainedPatchFallbacks++;
        retainedValid = false; committedOverrides = null;
        if (asyncSubmissionRevision === revision) asyncSubmissionRevision = null;
        const reason = outcome && typeof outcome === "object" ? (outcome as PresentationResult).reason : undefined;
        if (reason === "retained patch requires full scene admission") {
          if (asyncAwaitingAckRevision === revision && reconcilePull) {
            asyncAwaitingAckRevision = null;
            traceWarmRenderer("renderer-pull-recovery", revision);
            reconcilePull.now();
          } else if (state && readiness === "ready") paint(state, "recovery", "async-full-admission");
          return;
        }
        if (reason && !/pending|resource|in flight/i.test(reason)) publishStatus("failed", reason);
        if (asyncAwaitingAckRevision === revision && reconcilePull) {
          asyncAwaitingAckRevision = null;
          traceWarmRenderer("renderer-pull-refused", revision);
          reconcilePull.now();
        } else scheduler.scheduleTexturePaint();
        return;
      }
      publishRetainedPatch(patch, at, wire, outcome, landingCandidate);
      if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "committed");
      wire?.changedIds.clear();
      if (wire) wire.sceneRewrite = false;
      if (rustDiagnosticMode) retainedAsyncPublished++;
      asyncPresentedRevision = revision;
      asyncSubmissionRevision = null;
      traceWarmRenderer("renderer-async-published", revision);
      if (retryPendingView(revision)) {
        if (asyncAwaitingAckRevision === revision) asyncAwaitingAckRevision = null;
      } else if (asyncAwaitingAckRevision === revision && reconcilePull) {
        asyncAwaitingAckRevision = null;
        traceWarmRenderer("renderer-pull", revision);
        reconcilePull.now();
      } else scheduler.armAnimation(deterministicClock ?? performance.now());
      startupCompletionHook?.();
    }).catch((error: unknown) => {
      if (!asyncPresentation.current(ticket)) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(
        phaseSubmissionId, disposed ? "disposed" : "superseded"); return; }
      if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
      producerReasons?.noteNonBuild("retained-presentation-error");
      retainedPatchFallbacks++;
      retainedValid = false; committedOverrides = null;
      if (asyncSubmissionRevision === revision) asyncSubmissionRevision = null;
      publishStatus("failed", error instanceof Error ? error.message : String(error));
      scheduler.scheduleTexturePaint();
    });
  }

  function tryRetainedWire(next: MirrorState, at: number): boolean {
    const refuse = (reason: string) => { retainedDecline = reason; return false; };
    if (!retainedMode || !retainedValid || !retained || !pixi || !snapshot) return refuse("invalid-retained-state");
    if (next.sceneRewrite) return refuse("scene-rewrite");
    if (interaction.offsetPending || !interaction.cosmeticOffsetsMatch(snapshot)) return refuse("offset-pending");
    retainedDecline = "plan-unsupported";
const traceId = nextTraceFrame();
    const planStarted = rustPhaseTimingMode ? performance.now() : 0;
    const plan = traceId === null ? () => planRetainedSample(next) : () => tracePhase(traceId, "patch", () => planRetainedSample(next));
    const patch = lifecycle ? lifecycle.phase("patch", plan) : plan();
    if (rustDiagnosticMode) retainedPlanCount++;
    if (rustPhaseTimingMode) retainedPlanMs += performance.now() - planStarted;
    if (!patch) return false;
    if (visual.landingArms.length > 0 || (visual.hasOpenLanding() &&
      (patch.movedRoots > 0 || patch.hits.length > 0 || patch.nodeMatrices.length > 0)))
      return refuse("landing-requires-full-build");
    const landingCandidate = visual.captureLandingPresentation(next, at, snapshot.capturedGlobals, interaction.cosmeticOffsetsFor(snapshot));
    if (next.changedIds.size === 0) {
      let committed: PresentationResult;
      let phaseSubmissionId: number | undefined;
      try {
        const submitted = submitRetainedPatch(patch, traceId);
        phaseSubmissionId = submitted.phaseSubmissionId;
        const result = submitted.result;
        if (isPromiseLike<PresentationResult>(result)) { trackAsyncRetainedPatch(result, patch, at, next, phaseSubmissionId, landingCandidate); return refuse("async-in-flight"); }
        if (!result.presented) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
          return refuse("presentation-refused"); }
        committed = result;
      } catch { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
        return refuse("presentation-error"); }
      publishRetainedPatch(patch, at, next, committed, landingCandidate);
      if (rustExecutionPhaseMode) producerReasons!.finishRetainedIfOpen(phaseSubmissionId!, "committed");
      return true;
    }
    const global = (nodes: ReadonlyMap<string, MirrorNode>, id: string): Affine => {
      const chain: MirrorNode[] = [];
      for (let node = nodes.get(id); node; node = node.parentId ? nodes.get(node.parentId) : undefined) chain.push(node);
      let pose: Affine = [1, 0, 0, 1, 0, 0];
      for (let i = chain.length - 1; i >= 0; i--) if (chain[i].transform) pose = affineMul(pose, chain[i].transform as Affine);
      return pose;
    };
    const spans: Array<{ start: number; end: number }> = [];
    // rustHeldOverridePatch: a streamed delta is the drawn delta only away from held overrides. On or under one the
    // node draws through the override's absolute pose; above one, the span would carry the overridden node along.
    const heldLineage = fast.heldOverridePatch && visual.transformOverrides.size
      ? overrideAncestors(visual.transformOverrides, next.nodes) : null;
    for (const id of next.changedIds) {
      const before = snapshot.scene.nodes.get(id), after = next.nodes.get(id);
      if (!before || !after || before.parentId !== after.parentId || !before.transform || !after.transform) return refuse("wire-structure");
      // A volatile upsert rebuilds its colour objects, so the held-override lane compares small values by value.
      if (fast.heldOverridePatch) {
        if (!sameNodeExceptTransform(before, after)) return refuse("wire-nontransform-change");
        if (heldLineage && touchesOverrideLineage(id, visual.transformOverrides, heldLineage, next.nodes)) return refuse("wire-under-override");
      } else for (const key of Object.keys(before) as Array<keyof typeof before>)
        if (key !== "transform" && before[key] !== after[key]) return refuse("wire-nontransform-change");
      const inverse = affineInverse(global(snapshot.scene.nodes, id));
      if (!inverse) return refuse("wire-noninvertible");
      const delta = affineMul(global(next.nodes, id), inverse);
      const span = snapshot.paintOrder.entries.get(id);
      if (!span || spans.some((other) => other.start < span.spanEnd && span.spanStart < other.end)) return refuse("wire-overlapping-span");
      spans.push({ start: span.spanStart, end: span.spanEnd });
      for (const captured of snapshot.capturedGlobals.keys()) {
        const entry = snapshot.paintOrder.entries.get(captured);
        if (entry && entry.order >= span.spanStart && entry.order < span.spanEnd) return refuse("wire-captured-global");
      }
      const part = retained.patchWireTransform(id, delta);
      if (!part) return refuse("wire-transform-unsupported");
      patch.primitives.push(...part.primitives);
      patch.hits.push(...part.hits);
      patch.nodeMatrices.push(...part.nodeMatrices);
      patch.movedRoots++;
    }
    let committed: PresentationResult;
    let phaseSubmissionId: number | undefined;
    try {
      const submitted = submitRetainedPatch(patch, traceId);
      phaseSubmissionId = submitted.phaseSubmissionId;
      const result = submitted.result;
if (isPromiseLike<PresentationResult>(result)) { trackAsyncRetainedPatch(result, patch, at, next, phaseSubmissionId, landingCandidate); return refuse("async-in-flight"); }
      if (!result.presented) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
        return refuse("presentation-refused"); }
      committed = result;
    } catch { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
      return refuse("presentation-error"); }
    publishRetainedPatch(patch, at, next, committed, landingCandidate);
    if (rustExecutionPhaseMode) producerReasons!.finishRetainedIfOpen(phaseSubmissionId!, "committed");
    return true;
  }

  function planRetainedSample(next: MirrorState): RetainedPixiPatch | null {
    const refuse = (reason: string) => { retainedDecline = reason; return null; };
    if (!retainedMode || !retainedValid || !snapshot || !retained || !pixi || readiness !== "ready") {
      retainedDecline = "invalid-retained-state"; return null;
    }
    // rustHeldOverridePatch admits overrides held unchanged since the committed build: the same keys, bitwise.
    if (fast.heldOverridePatch) {
      if (!committedOverrides || !sameTransformOverrides(visual.transformOverrides, committedOverrides)) return refuse("transform-overrides");
    } else if (visual.transformOverrides.size) { retainedDecline = "transform-overrides"; return null; }
    if ((visual.frameSampleMask & ~(SAMPLE_LOCAL_ANIM | SAMPLE_OPACITY | SAMPLE_SELF_OPACITY | SAMPLE_SOURCE)) !== 0) {
      retainedDecline = "unsupported-sample"; return null;
    }
    const held = fast.heldOverridePatch && visual.transformOverrides.size > 0;
    // An overridden node draws at its absolute pose whatever its ancestors do, so a local animation above it must
    // not carry it along. The build's frames never include a root that carries an override itself.
    if (held) {
      const ancestors = overrideAncestors(visual.transformOverrides, snapshot.scene.nodes);
      for (const root of snapshot.build.localAnimFrames.keys()) if (ancestors.has(root)) return refuse("anim-over-override");
    }
    if (interaction.offsetPending || !interaction.cosmeticOffsetsMatch(snapshot)) { retainedDecline = "offset-pending"; return null; }
    const patch = retained.patch(visual.localAnims);
    if (!patch) { retainedDecline = "composition-refused"; return null; }
    if (held) heldPatches.set(patch, fast.verify ? captureHeldInputs() : null);
    const byId = new Map(patch.primitives.map((entry) => [entry.id, entry]));
    const update = (id: string) => {
      let entry = byId.get(id);
      if (!entry) { entry = { id }; patch.primitives.push(entry); byId.set(id, entry); }
      return entry;
    };
    const base = snapshot;
    const quad = createQuadView(), nine = createNinePatchView(), mesh = createTexturedMeshView();
    if (visual.opacitySampledIds.size) {
      const touched = new Set<string>();
      for (const root of visual.opacitySampledIds) {
        const span = base.paintOrder.entries.get(root);
        if (!span) return refuse("opacity-missing-span");
        for (let i = span.spanStart; i < span.spanEnd; i++) touched.add(base.paintOrder.ids[i]);
      }
      const mods: number[] = [];
      for (const id of touched) {
        let ratio = 1, ownSelf = 1;
        mods.length = 0;
        const streamed = { mod: 1, self: 1 };
        for (let node = next.nodes.get(id); node; node = node.parentId ? next.nodes.get(node.parentId) : undefined) {
          const applied = visual.alphaApplied.get(node.id), current = visual.alphaOverrides.get(node.id);
          streamedAlphasOf(node, streamed);
          const oldMod = applied?.mod ?? streamed.mod;
          const newMod = current?.mod ?? streamed.mod;
          if (oldMod <= 0 || !Number.isFinite(newMod)) return refuse("opacity-invalid-ratio");
          ratio *= newMod / oldMod;
          mods.push(newMod);
          if (node.id === id) {
            const oldSelf = applied?.self ?? streamed.self;
            const newSelf = current?.self ?? streamed.self;
            if (oldSelf <= 0 || !Number.isFinite(newSelf)) return refuse("opacity-invalid-ratio");
            ratio *= newSelf / oldSelf;
            ownSelf = newSelf;
          }
        }
        // rustHeldOverridePatch: a build skips a node at or below the paint threshold, so carrying one across it adds
        // or drops commands, text records and a painting hit surface that no alpha patch can express. The opacity
        // here is what a build would compose now, multiplied root-first exactly as the walk does.
        if (fast.heldOverridePatch) {
          const input = base.build.nodePaintInputs.get(id), node = visual.frameSubstitutes.get(id) ?? next.nodes.get(id);
          if (input && node && !input.hidden) {
            let opacity = 1;
            for (let i = mods.length - 1; i >= 0; i--) opacity *= mods[i];
            if (nodeIsPainting(input.node, input.ownOpacity) !== nodeIsPainting(node, opacity * ownSelf)) return refuse("opacity-paint-threshold");
          }
        }
        const range = base.build.ranges.get(id);
        if (range) for (let index = range.start; index < range.paintEnd; index++) {
          const kind = list.kindNameAt(index);
          let alpha: number;
          if (kind === "quad") alpha = list.readQuad(index, quad).a;
          else if (kind === "ninePatch") alpha = list.readNinePatch(index, nine).a;
          else if (kind === "texturedMesh") alpha = list.readTexturedMesh(index, mesh).a;
          else return refuse("opacity-unsupported-command");
          const value = alpha * ratio;
          if (!Number.isFinite(value) || value < 0 || value > 1) return refuse("opacity-invalid-value");
          update(`${id}:${kind}:${index - range.start}`).alpha = value;
        }
        for (const key of textKeysByOwner.get(id) ?? []) {
          const text = texts.find((entry) => entry.key === key);
          if (!text) return refuse("opacity-missing-text");
          const value = (text.alpha ?? 1) * ratio;
          if (!Number.isFinite(value) || value < 0 || value > 1) return refuse("opacity-invalid-value");
          update(`text:${key}`).alpha = value;
        }
      }
    }
    if (visual.sourceSampledIds.size) for (const id of visual.sourceSampledIds) {
      const node = visual.frameSubstitutes.get(id) ?? next.nodes.get(id);
      const range = base.build.ranges.get(id);
      if (!node?.textureUrl || !range || range.paintEnd !== range.start + 1 || list.kindNameAt(range.start) !== "quad") return refuse("source-unsupported-command");
      const size = pixi.textureSize(node.textureUrl);
      if (!size) { pixi.prefetch(node.textureUrl); return refuse("source-resource-pending"); }
      const current = list.readQuad(range.start, quad);
      const region = node.textureRegion;
      const x = region?.x ?? 0, y = region?.y ?? 0, w = region?.width ?? size.width, h = region?.height ?? size.height;
      if (!(w > 0 && h > 0) || !Number.isFinite(x + y + w + h)) return refuse("source-invalid-region");
      const input = base.build.nodePaintInputs.get(id);
      if (!input || !region || !(current.w > 0 && current.h > 0)) return refuse("source-missing-input");
      const fit = atlasFitAffine({ node, opacity: 1, tintId: null, parentInv: null, hasChildren: false },
        input.global, node.localRect, false);
      if (!fit || !(fit.w > 0 && fit.h > 0)) return refuse("source-fit-refused");
      // Express the new fitted sprite in the retained command's fixed box.
      // This keeps trimmed atlas frames and changing margins patchable.
      const matrix: Affine = [fit.m[0] * fit.sx * fit.w / current.w,
        fit.m[1] * fit.sx * fit.w / current.w, fit.m[2] * fit.sy * fit.h / current.h,
        fit.m[3] * fit.sy * fit.h / current.h, fit.m[4], fit.m[5]];
      const flip = normalizeFlip(matrix, current.w, current.h, fit.sx < 0, fit.sy < 0);
      if (flip.h !== current.flipH || flip.v !== current.flipV || !matrix.every(Number.isFinite)) return refuse("source-invalid-transform");
      const key = `${id}:quad:0`;
      const entry = update(key);
      const posed = retained.sourceTransform(key, matrix, entry.transform);
      if (!posed) return refuse("source-transform-refused");
      entry.transform = posed;
      entry.source = { texture: node.textureUrl, x, y, w, h };
      patch.sourceReferences.push({ id: key, matrix });
    }
    return patch;
  }

  // rustFastVerify: the visual inputs a held-override patch was planned from, by value, so the shadow build of its
  // picture sees the same sample even when the patch publishes asynchronously.
  function captureHeldInputs(): HeldPatchInputs {
    const anims = new Map<string, LocalAnim>();
    for (const [id, anim] of visual.localAnims) anims.set(id, { pre: anim.pre?.slice() ?? null, post: anim.post?.slice() ?? null });
    const alphas = new Map<string, AlphaOverride>();
    for (const [id, alpha] of visual.alphaOverrides) alphas.set(id, { mod: alpha.mod, self: alpha.self });
    const offsets = new Map<string, CosmeticOffset>();
    for (const [id, offset] of interaction.cosmeticOffsets) offsets.set(id, { ...offset });
    return { overrides: copyTransformOverrides(visual.transformOverrides), alphas, anims,
      substitutes: new Map(visual.frameSubstitutes), offsets };
  }

  /**
   * rustFastVerify: rebuild the picture a committed held-override patch claims to show, without submitting it, and
   * compare matrices: every owned command (and clip rect), every text record and every hit entry's mFinal/mGame.
   * The shadow writes its own draw list; it borrows the live text and spread scratch the build callbacks fill, and
   * puts both back before returning. Tolerance is relative 1e-5: the list stores float32 while patches compose
   * in float64, so the two spellings of one pose differ in the last bits.
   */
  function verifyHeldOverridePatch(inputs: HeldPatchInputs): void {
    const current = state, drawn = snapshot, composition = retained;
    if (!current || !drawn || !composition) return;
    heldOverrideVerifyRuns++;
    const shadow = createDrawList<string>();
    const skipRoots = new Set<string>();
    if (staticBackground) for (const node of current.nodes.values())
      if (staticBgTargetPathOf(node, current.nodes) !== null && isStaticBackgroundSuppressibleRoot(node, current.nodes)) skipRoots.add(node.id);
    const refill = <K, V>(map: Map<K, V>, entries: ReadonlyArray<[K, V]>) => { map.clear(); for (const [k, v] of entries) map.set(k, v); };
    const liveTexts = texts.slice(), liveOwners = [...textOwners], liveKeys = [...textKeysByOwner], liveFailures = [...semanticFailures];
    const liveDx = [...spreadDxByNode], liveModes = [...spreadFieldModeByNode], liveLayouts = nativeLayouts;
    texts.length = 0; textOwners.clear(); textKeysByOwner.clear(); semanticFailures.clear(); spreadDxByNode.clear(); spreadFieldModeByNode.clear();
    let reference: DrawListBuild | null = null, referenceTexts: PixiTextRecord[] = [], refused: string | null = null;
    try {
      reference = buildDrawList(current, shadow, { scratch: createPaintScratch(), skipRoots,
        skipHiddenHitCandidates: rustSkipHiddenHitCandidates, handRaiseChrome: handRaiseChrome ? handRaiseChromePainter : null,
        textureSize: (url) => pixi?.textureSize(url) ?? null, spreadFactor: visual.spreadFactor,
        spreadRegistry: visual.spreadRegistry, spreadDxOut: spreadDxByNode, spreadFieldModeOut: spreadFieldModeByNode,
        transformOverrides: inputs.overrides.size ? inputs.overrides : null, alphaOverrides: inputs.alphas.size ? inputs.alphas : null,
        localAnims: inputs.anims.size ? inputs.anims : null, frameSubstitutes: inputs.substitutes.size ? inputs.substitutes : null,
        viewScaleEnv: visual.viewScaleEnv, tipScaleEnv: visual.tipScaleEnv, pinnedLocals: visual.pinnedLocals,
        cosmeticOffsets: inputs.offsets, semanticText,
        semanticOverlay: (input, record, index) => semanticOverlay(input, record, index, shadow), assert: false });
      if (semanticFailures.size !== liveFailures.length ||
          [...semanticFailures].some(([id, reason]) => liveFailures.find(([liveId]) => liveId === id)?.[1] !== reason))
        refused = "semantic omissions changed during shadow build";
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    } finally {
      referenceTexts = texts.slice();
      texts.length = 0; for (const text of liveTexts) texts.push(text);
      refill(textOwners, liveOwners); refill(textKeysByOwner, liveKeys); refill(semanticFailures, liveFailures);
      refill(spreadDxByNode, liveDx); refill(spreadFieldModeByNode, liveModes); nativeLayouts = liveLayouts;
    }
    let mismatches = 0;
    const notes: string[] = [];
    const note = (detail: string) => { mismatches++; heldOverrideVerifyFirstMismatch ??= detail; if (notes.length < 32) notes.push(detail); };
    // What a mismatching owner looked like on each side: its opacity and hidden state as drawn and as rebuilt.
    const ownerState = (id: string | undefined) => {
      if (!id) return "owner=?";
      const was = drawn.build.nodePaintInputs.get(id), now = reference?.nodePaintInputs.get(id), node = current.nodes.get(id);
      return `owner=${id} ${node?.nodeType ?? "?"} visible=${node?.visible ?? "?"} opacity ${was?.ownOpacity ?? "-"}` +
        `${was?.hidden ? "(hidden)" : ""}->${now?.ownOpacity ?? "-"}${now?.hidden ? "(hidden)" : ""}`;
    };
    const matches = (expected: ArrayLike<number>, actual: ArrayLike<number> | undefined, count = 6): boolean => {
      if (!actual) return false;
      let within = true;
      for (let i = 0; i < count; i++) {
        const error = Math.abs(expected[i] - actual[i]);
        if (!(error <= 1e-5 * Math.max(1, Math.abs(expected[i]), Math.abs(actual[i])))) within = false;
        if (!(error <= heldOverrideVerifyMaxError)) heldOverrideVerifyMaxError = Number.isNaN(error) ? Infinity : error;
      }
      return within;
    };
    if (refused !== null || !reference) note(`shadow build: ${refused}`);
    else {
      const quad = createQuadView(), nine = createNinePatchView(), mesh = createTexturedMeshView();
      const clip = createClipRectView(), liveClip = createClipRectView(), line = createPolylineView(), liveLine = createPolylineView();
      for (const owner of drawn.build.ranges.keys())
        if (!reference.ranges.has(owner)) note(`commands drawn, not rebuilt: ${ownerState(owner)}`);
      for (const [owner, range] of reference.ranges) {
        const committedRange = drawn.build.ranges.get(owner), count = range.paintEnd - range.start;
        if (!committedRange) { note(`commands rebuilt, not drawn: ${ownerState(owner)}`); continue; }
        if (committedRange.paintEnd - committedRange.start !== count) { note(`${owner}: command count ${committedRange.paintEnd - committedRange.start} drawn, ${count} rebuilt`); continue; }
        for (let ordinal = 0; ordinal < count; ordinal++) {
          const index = range.start + ordinal, liveIndex = committedRange.start + ordinal;
          const kind = shadow.kindNameAt(index), key = `${owner}:${kind}:${ordinal}`;
          if (kind !== list.kindNameAt(liveIndex)) note(`${key}: kind`);
          else if (kind === "quad" || kind === "ninePatch" || kind === "texturedMesh") {
            const m = kind === "quad" ? shadow.readQuad(index, quad).m
              : kind === "ninePatch" ? shadow.readNinePatch(index, nine).m : shadow.readTexturedMesh(index, mesh).m;
            if (!matches(m, composition.logicalMatrix(key))) note(key);
          } else if (kind === "polyline") {
            // A polyline is baked in design space; its retained matrix is the delta applied since admission.
            const delta = composition.logicalMatrix(key);
            const rebuilt = shadow.readPolyline(index, line), committed = list.readPolyline(liveIndex, liveLine);
            let within = !!delta && rebuilt.pointCount === committed.pointCount;
            for (let p = 0; within && p < rebuilt.pointCount; p++) {
              const x = committed.points[p * 2], y = committed.points[p * 2 + 1];
              within = matches([rebuilt.points[p * 2], rebuilt.points[p * 2 + 1]],
                [delta![0] * x + delta![2] * y + delta![4], delta![1] * x + delta![3] * y + delta![5]], 2);
            }
            if (!within) note(key);
          } else if (kind === "clipPush") {
            // Retained patches never move a clip rect, so the committed one must still be the rebuilt one.
            const rebuilt = shadow.readClipRect(index, clip), committed = list.readClipRect(liveIndex, liveClip);
            if (!matches([rebuilt.x, rebuilt.y, rebuilt.w, rebuilt.h], [committed.x, committed.y, committed.w, committed.h], 4)) note(key);
          }
        }
      }
      const drawnTexts = new Set(texts.map((record) => record.key)), rebuiltTexts = new Set(referenceTexts.map((record) => record.key));
      for (const record of texts) if (!rebuiltTexts.has(record.key))
        note(`text drawn, not rebuilt: ${record.key} alpha ${record.alpha ?? 1}->${retainedDiagnosticFields.get(`text:${record.key}`)?.alpha ?? "unpatched"} ${ownerState(textOwners.get(record.key))}`);
      for (const record of referenceTexts) {
        if (!drawnTexts.has(record.key)) note(`text rebuilt, not drawn: ${record.key} alpha ${record.alpha ?? 1} ${ownerState(record.labelId)}`);
        else if (!matches(record.transform, composition.logicalMatrix(`text:${record.key}`))) note(`text:${record.key}`);
      }
      if (reference.hitEntries.length !== drawn.hitEntries.length)
        note(`hit entries: ${drawn.hitEntries.length} drawn, ${reference.hitEntries.length} rebuilt`);
      else for (let i = 0; i < drawn.hitEntries.length; i++) {
        const rebuilt = reference.hitEntries[i], committed = drawn.hitEntries[i];
        if (rebuilt.nodeId !== committed.nodeId || !matches(rebuilt.mFinal, committed.mFinal) ||
          !matches(rebuilt.mGame, committed.mGame)) note(`hit:${committed.nodeId}${rebuilt.nodeId !== committed.nodeId ? ` vs ${rebuilt.nodeId}` : ""}`);
      }
    }
    heldOverrideVerifyMismatches += mismatches;
    if (notes.length && heldOverrideVerifyLog.length < 16)
      heldOverrideVerifyLog.push({ run: heldOverrideVerifyRuns, revision: current.revision, clock: drawnClock, notes, recent: heldOverrideRecent.slice() });
  }

  function tryRetainedPatch(at: number): boolean {
    if (!state || !snapshot || snapshot.stateRevision !== state.revision || !pixi) {
      retainedDecline = "invalid-retained-state"; return false;
    }
    retainedDecline = "plan-unsupported";
const traceId = nextTraceFrame();
    const planStarted = rustPhaseTimingMode ? performance.now() : 0;
    const plan = traceId === null ? () => planRetainedSample(state!) : () => tracePhase(traceId, "patch", () => planRetainedSample(state!));
    const patch = lifecycle ? lifecycle.phase("patch", plan) : plan();
    if (rustDiagnosticMode) retainedPlanCount++;
    if (rustPhaseTimingMode) retainedPlanMs += performance.now() - planStarted;
    if (!patch) { retainedPatchFallbacks++; return false; }
    if (visual.landingArms.length > 0 || (visual.hasOpenLanding() &&
      (patch.movedRoots > 0 || patch.hits.length > 0 || patch.nodeMatrices.length > 0))) {
      retainedDecline = "landing-requires-full-build"; retainedPatchFallbacks++; return false;
    }
    const landingCandidate = visual.captureLandingPresentation(state, at, snapshot.capturedGlobals, interaction.cosmeticOffsetsFor(snapshot));
    let committed: PresentationResult;
    let phaseSubmissionId: number | undefined;
    try {
      const submitted = submitRetainedPatch(patch, traceId);
      phaseSubmissionId = submitted.phaseSubmissionId;
      const result = submitted.result;
      if (isPromiseLike<PresentationResult>(result)) { trackAsyncRetainedPatch(result, patch, at, undefined, phaseSubmissionId, landingCandidate); retainedDecline = "async-in-flight"; return false; }
      if (!result.presented) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
        retainedPatchFallbacks++; retainedDecline = "presentation-refused"; return false; }
      committed = result;
    } catch { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
      retainedPatchFallbacks++; retainedDecline = "presentation-error"; return false; }
    publishRetainedPatch(patch, at, undefined, committed, landingCandidate);
    if (rustExecutionPhaseMode) producerReasons!.finishRetainedIfOpen(phaseSubmissionId!, "committed");
    return true;
  }

  function logicalPaintRows(): string[] {
    if (!build || !state) return [];
    const rows = semanticRows.map((row) => {
      if (!retainedMode || !retainedValid || !retained) return JSON.stringify(row);
      const id = row.id as string;
      const copied = { ...row };
      const baseTransform = row.transform as Affine | undefined;
      if (baseTransform) copied.transform = retained.logicalNodeMatrix(id, baseTransform);
      const primitives = row.primitives as Array<Record<string, unknown>> | undefined;
      const range = build?.ranges.get(id);
      if (primitives && range) copied.primitives = primitives.map((primitive, ordinal) => {
        const index = range.start + ordinal;
        const key = `${id}:${list.kindNameAt(index)}:${ordinal}`;
        const matrix = retained!.logicalMatrix(key);
        const fields = retainedDiagnosticFields.get(key);
        if (!matrix && !fields) return primitive;
        const item = { ...primitive };
        if (matrix) item.m = matrix;
        if (fields?.source) {
          item.texture = fields.source.texture;
          item.src = [fields.source.x, fields.source.y, fields.source.w, fields.source.h];
        }
        if (fields?.alpha !== undefined && Array.isArray(item.rgba)) {
          const rgba = item.rgba as number[];
          const ratio = rgba[3] > 0 ? fields.alpha / rgba[3] : 0;
          item.rgba = [rgba[0] * ratio, rgba[1] * ratio, rgba[2] * ratio, fields.alpha];
        }
        return item;
      });
      return JSON.stringify(copied);
    });
    return rows;
  }

  resize();
  startupEvent("renderer.initStart", { sliceSupported });
  if (!sliceSupported) publishStatus("failed", `${backend === "rust" ? "Rust/WASM" : "Pixi"} requires Very low quality, shaders and particles Off, static background On, and static spines`);
  const onInvalidate = (reason?: "resource" | "present") => {
    if (reason === "present") { scheduleRefinement(); return; }
    if (!disposed && state && pixi) { if (producerReasons) resourceEpoch++; scheduler.scheduleTexturePaint(); if (reconcilePull?.pending()) { traceWarmRenderer("renderer-pull-font", state.revision); reconcilePull.now(); } }
    if (!disposed) signalDiagnosticWake();
  };
  const executorOptions: ExecutorOptions = { canvas, width: backingW, height: backingH,
    designWidth: Math.max(1, stage.clientWidth), designHeight: Math.max(1, stage.clientHeight),
    startupRendererInstance: startupCommitHook ? instance : undefined, onInvalidate, profile };
  const init = sliceSupported && (backend !== "rust" || measureContext !== null) ? options.createExecutor ? options.createExecutor(executorOptions) : Promise.all([
    import("@godot-scene-web/canvas/pixi"),
    textMode === "native" ? Promise.resolve(null) : import("@/mirror/canvas/glyphPass").catch(() => null),
  ]).then(([{ createPixiDrawListRenderer }, glyphModule]) => createPixiDrawListRenderer<string>({ canvas, width: backingW, height: backingH, designWidth: Math.max(1, stage.clientWidth), designHeight: Math.max(1, stage.clientHeight), resolution: 1, antialias: false,
    textureUrl: (url) => url, identityAt: commandIdentity,
    textMode,
    diagnostics: pixiDiagnostics,
    diagnosticClipMode: clipControl,
    diagnosticSubmitMode: submitControl,
    onInvalidate,
    createGlyphProvider: !glyphModule ? undefined : (gl): PixiGlyphProvider => {
      const registry = glyphModule.createGlyphPassRegistry({ gl, designWidth: Math.max(1, stage.clientWidth),
        designHeight: Math.max(1, stage.clientHeight),
        metrics: (cssFont) => {
          if (!measureContext || !stage.ownerDocument.fonts?.check(cssFont)) return null;
          measureContext.font = cssFont;
          const sample = measureContext.measureText("Mg");
          const ascent = sample.fontBoundingBoxAscent, descent = sample.fontBoundingBoxDescent;
          return ascent > 0 && descent >= 0 ? { ascent, descent } : null;
        },
        onReady: wakeForResource });
      glyphRegistry = registry;
      return registry;
    },
  })) : Promise.reject(new Error(failure || "2D text measurement context unavailable"));
  void init.then((created) => {
    if (disposed) { created.dispose(); return; }
    pixi = created; readiness = "ready"; resize();
    startupEvent("renderer.initComplete", { contextReady: created.stats.contextReady,
      pending: created.stats.resourcePending, failed: created.stats.textureFailures });
    if (state) deferredPaint(state, "startup");
    else onStatus?.("initializing"); // Engine is ready; wait for the first scene without re-locking reconcile.
  }).catch((error: unknown) => {
    const verboseRustError = backend === "rust" && new URLSearchParams(window.location.search).get("rustDebug") === "1";
    const reason = error instanceof Error ? (verboseRustError ? error.stack ?? error.message : error.message) : String(error);
    publishStatus("failed", reason);
  });
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  observer?.observe(stage); if (host !== stage) observer?.observe(host);

  const glyphPending = () => {
    const status = glyphRegistry?.stats();
    return status ? (status.ready === null ? 1 : 0) + status.facesPending : 0;
  };
  const diagnostics = (): PixiRendererDiagnostics => ({
    backend, instance,
    readiness: backend !== "rust" && readiness === "ready" && (pixi?.stats.textureFailures ?? 0) > 0 ? "failed" : readiness,
    ready: readiness === "ready" && pixi?.stats.contextReady === true && pixi.stats.presentationValid === true && (pixi.stats.completedFrames ?? 0) > 0 && (pixi.stats.resourcePending ?? 0) === 0 && glyphPending() === 0 && !refinementPending && !refinementFailure && (backend === "rust" || (pixi.stats.textureFailures ?? 0) === 0),
    ...((failure || (backend !== "rust" && pixi?.textureFailureDetails().length)) ? { failure: failure ?? pixi?.textureFailureDetails().join(" | ") } : {}),
    ...(backend === "rust" && (semanticFailures.size || (pixi?.stats.textureFailures ?? 0) > 0)
      ? { omissions: { nodes: Object.fromEntries(semanticFailures), textures: pixi?.textureFailureDetails() ?? [] } } : {}),
    ...(refinementFailure ? { refinementFailure } : {}),
    admittedRevision: snapshot?.stateRevision,
    asyncSubmissionRevision, asyncPresentedRevision, asyncAwaitingAckRevision,
    frameIdentity: snapshot ? { revision: snapshot.stateRevision, buildEpoch: snapshot.buildEpoch, presentEpoch: frameEpoch, clock: drawnClock } : null,
    resources: { pending: (readiness === "initializing" ? 1 : 0) + (pixi?.stats.resourcePending ?? 0) + fontPending.size + spinePending.size + glyphPending() + (refinementPending ? 1 : 0) + (pixi && !pixi.stats.presentationValid ? 1 : 0), failed: (pixi?.stats.textureFailures ?? 0) + fontFailed.size + spineFailed.size + semanticFailures.size + (readiness === "failed" ? 1 : 0) + (refinementFailure ? 1 : 0) },
    pendingBreakdown: { initializing: readiness === "initializing" ? 1 : 0, textures: pixi?.stats.resourcePending ?? 0,
      fonts: fontPending.size, spines: spinePending.size, glyphs: glyphPending(), refinement: refinementPending ? 1 : 0,
      presentation: pixi && !pixi.stats.presentationValid ? 1 : 0 },
    draw: { frames: pixi?.stats.frames ?? 0, completedFrames: pixi?.stats.completedFrames ?? 0, retainedPatches, retainedPatchObjects, retainedPatchFallbacks, nativeLayouts, refinementPending: refinementPending ? 1 : 0, objects: pixi?.stats.objects ?? 0,
      ...(rustDiagnosticMode ? { producerBuilds, retainedPlanCount, retainedAsyncSubmitted, retainedAsyncPublished } : {}),
      ...(rustDiagnosticMode ? { retainedValid: retainedValid ? 1 : 0, transformOverrideCount: visual.transformOverrides.size,
        frameSampleMask: visual.frameSampleMask, localAnimationCount: visual.localAnims.size,
        opacitySampleCount: visual.opacitySampledIds.size, sourceSampleCount: visual.sourceSampledIds.size } : {}),
      ...(rustPhaseTimingMode ? { retainedPlanMs, producerBuildMs } : {}),
      ...(fast.lazyComposition ? { lazyCompositionIndexBuilds, lazyCompositionVerifyMismatches } : {}),
      ...(fast.snapshotReuse ? { snapshotNodeReuses, staticSkipRootReuses, rewardFocusSkips } : {}),
      // rustSceneIndex: reward-focus candidates/the static-bg skip-root memo (both here) plus
      // interactionRuntime's own hand-present/cover-above candidates (item 3) share one counter.
      ...(fast.sceneIndex ? { sceneIndexVerifyMismatches: sceneIndexVerifyMismatches + interaction.sceneIndexVerifyMismatches } : {}),
      textures: pixi?.stats.textures ?? 0, frameTextures: pixi?.stats.frameTextures ?? 0, gpuTextures: pixi?.stats.gpuTextures ?? 0,
      textureLoads: pixi?.stats.textureLoads ?? 0, created: pixi?.stats.created ?? 0, updated: pixi?.stats.updated ?? 0,
      destroyed: pixi?.stats.destroyed ?? 0, textRasterizations: pixi?.stats.textRasterizations ?? 0,
      textInvalidations: pixi?.stats.textInvalidations ?? 0,
      refusedEffects: pixi?.stats.refusedEffects ?? 0, refusedGlyphs: pixi?.stats.refusedGlyphs ?? 0,
      blockedPendingFrames: pixi?.stats.blockedPendingFrames ?? 0, blockedRefusedFrames: pixi?.stats.blockedRefusedFrames ?? 0 },
    lifecycle: { disposed: disposed ? 1 : 0, contexts: pixi ? 1 : 0, contextReady: pixi?.stats.contextReady ? 1 : 0, presentationValid: pixi?.stats.presentationValid ? 1 : 0 },
    effective: { quality: effectiveMirrorQuality().tier, shaders: effectiveMirrorRenderSettings(mirrorSettings).shaderMode,
      particles: effectiveMirrorRenderSettings(mirrorSettings).particleMode,
      rustZeroCopyPixels: backend === "rust"
        ? (window as unknown as { __mirrorRustPixelControl?: boolean }).__mirrorRustPixelControl ?? null : null,
      staticBg: effectiveMirrorRenderSettings(mirrorSettings).staticBgEnabled ? 1 : 0,
      spineMode: effectiveMirrorRenderSettings(mirrorSettings).spineMode,
      designWidth: stage.clientWidth, designHeight: stage.clientHeight, backingWidth: backingW, backingHeight: backingH,
      dpr,
      ...(producerReasons ? { rustProducerReasons: producerReasons.snapshot() } : {}),
      ...(hiddenWalkMode ? { rustHiddenWalk: { rows: hiddenWalkRows.slice(), overflow: hiddenWalkOverflow } } : {}),
      webglVersion: (() => { const gl = (pixi?.app.renderer as unknown as { gl?: WebGLRenderingContext })?.gl; return gl ? gl.getParameter(gl.VERSION) : null; })(),
      renderer: (() => { const gl = (pixi?.app.renderer as unknown as { gl?: WebGLRenderingContext })?.gl; return gl ? gl.getParameter(gl.RENDERER) : null; })(),
      ageMs: performance.now() - createdAt, buildEpoch, commands: list.count, pixiScene: retainedMode ? "retained" : "legacy", idleCadence: displayPaced ? "display" : "authored",
      paintOrderReuse: paintOrderReuse ? 1 : 0,
      ...(backend === "rust" ? { rustOmitStaticPixelCaches, rustSkipHiddenHitCandidates,
        rustStaticAdmissionPhase: rustStaticAdmissionPhaseMode, rustFast: { ...fast },
        rustTextPrepCache: { textPrep: textPrepCache?.stats() ?? null, fontCheck: fontCheckCache?.stats() ?? null } } : {}),
      ...(lazyCompositionVerifyFirstMismatch ? { lazyCompositionVerifyFirstMismatch } : {}),
      ...(fast.heldOverridePatch ? { rustHeldOverride: { heldOverridePatches, heldOverrideDeclines: { ...heldOverrideDeclines }, ...(fast.verify ? { heldOverrideVerifyRuns, heldOverrideVerifyMismatches, heldOverrideVerifyMaxError, heldOverrideVerifyFirstMismatch, heldOverrideVerifyLog: heldOverrideVerifyLog.map((entry) => ({ ...entry, notes: [...entry.notes], recent: [...entry.recent] })) } : {}) } } : {}),
      ...(rustExecutionPhaseMode ? { rustExecutionPhases: true } : {}),
      ...(profile ? { canvasProfile: profile.snapshot() } : {}),
      ...(hiddenMemo ? { rustHiddenMemo: { ...hiddenMemo.stats, missReasons: { ...hiddenMemo.stats.missReasons },
        notRecorded: { ...hiddenMemo.stats.notRecorded } } } : {}),
      paintOrderPreparation: { completeHits: paintOrderCache.stats.completeHits, completeMisses: paintOrderCache.stats.completeMisses } },
    text: pixi?.textOutcomes() ?? null,
    glyphs: glyphRegistry?.stats() ?? null,
    ...(backend !== "rust" && semanticFailures.size ? { failure: [...semanticFailures].map(([id, reason]) => `${id}:${reason}`).join(",") } : {}),
  });
  const globals = window as unknown as Record<string, unknown>;
  globals.__mirrorRendererDiagnostics = diagnostics;
  // Internal bench seam for freezing the actual emitted command stream at a settled replay checkpoint.
  // Keep the payload to command identities/families: game content remains in the ignored capture receipt.
  if (attributionEnabled && attributionQuery.get("drawListDump") === "1") globals.__mirrorDrawListDump = () => {
    const families: Record<string, number> = {};
    const commands = Array.from({ length: list.count }, (_, index) => {
      const kind = list.kindNameAt(index);
      families[kind] = (families[kind] ?? 0) + 1;
      return { index, id: commandIdentity(index, list.kindAt(index)), kind, textured: list.textureAt(index) !== null };
    });
    return { revision: state?.revision ?? null, count: list.count, families, commands,
      textRecords: texts.map(({ key, insertionIndex, resourceRevision }) => ({ key, insertionIndex, resourceRevision })) };
  };
  if (pixiDiagnostics || clipControl || submitControl) globals.__pixiAttribution = () => {
    pixi?.pollDiagnostics();
    return { mode: attributionMode, clipControl: clipControl ?? null, submitControl: submitControl ?? null,
      commandFrames: commandFrames.slice(), gpuElapsed: gpuElapsed.slice(), cpuFrames: cpuFrames.slice(),
      omittedClipMasksLastSubmission: pixi?.stats.omittedClipMasksLastSubmission ?? null,
      omittedClipMasksTotalSubmissions: pixi?.stats.omittedClipMasksTotalSubmissions ?? null,
      skippedGlSubmissions: pixi?.stats.skippedGlSubmissions ?? null,
      diagnosticQuadSubmissions: pixi?.stats.diagnosticQuadSubmissions ?? null };
  };
  if (submitControl === "skip-gl") globals.__pixiArmSkipGl = () => pixi?.armDiagnosticSkipGl() ?? false;
  if (submitControl === "single-quad") globals.__pixiArmSingleQuad = () => pixi?.armDiagnosticSingleQuad() ?? false;
  if (lifecycle) globals.__mirrorFrameLifecycle = lifecycle.report;
  globals.__mirrorLogicalPaint = logicalPaintRows;
  globals.__mirrorFrameIdentity = () => diagnostics().frameIdentity;
  async function setRustDiagnosticClock(ms: number | null): Promise<unknown> {
    // The replay transport delivers the next wire message only after this resolves. A presentation
    // already in flight may therefore finish stale when another local reconcile changes `state`.
    // Resource completion or publication wakes another attempt. One deadline covers all waits,
    // including an executor promise that never settles; it never schedules another admission.
    cancelDiagnosticClock?.("superseded by a newer diagnostic clock");
    let abortReason: string | null = null;
    let releaseAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const abort = (reason: string) => { if (abortReason !== null) return; abortReason = reason; releaseAbort(); };
    cancelDiagnosticClock = abort;
    const deadline = window.setTimeout(() => abort("deadline exceeded"), 5_000);
    const assertActive = () => {
      if (disposed) abort("renderer disposed");
      if (readiness === "failed" || (backend !== "rust" && (pixi?.stats.textureFailures ?? 0) > 0))
        abort(failure ?? pixi?.textureFailureDetails().join(" | ") ?? "resource failed");
      if (abortReason !== null) {
        const identity = diagnostics().frameIdentity;
        throw new Error(`Rust diagnostic clock frame did not complete at ${String(ms)}: ${abortReason} ` +
          `(revision ${identity?.revision ?? "none"}, clock ${identity?.clock ?? "none"}, ` +
          `inFlight ${asyncSubmissionRevision ?? "none"}, pending ${JSON.stringify(diagnostics().pendingBreakdown)})`);
      }
    };
    const awaitCompletion = async (pending: Promise<void>) => {
      await Promise.race([pending.catch(() => { /* renderer status carries the failure */ }), aborted]);
      assertActive();
    };
    const awaitWake = async (seen: number) => {
      if (diagnosticWakeGeneration !== seen) return;
      let wake!: () => void;
      const signaled = new Promise<void>((resolve) => {
        wake = () => { diagnosticWakeWaiters.delete(wake); resolve(); };
        diagnosticWakeWaiters.add(wake);
      });
      if (diagnosticWakeGeneration !== seen) wake();
      try { await Promise.race([signaled, aborted]); }
      finally { diagnosticWakeWaiters.delete(wake); }
      assertActive();
    };
    try {
      let attempted = false;
      for (;;) {
        assertActive();
        if (asyncSubmissionRevision !== null && asyncPresentCompletion) {
          const pending = asyncPresentCompletion;
          await awaitCompletion(pending);
          if (asyncSubmissionRevision !== null && asyncPresentCompletion === pending)
            throw new Error(`Rust diagnostic presentation remained in flight after settling at ${String(ms)}`);
          continue;
        }
        const current = state;
        // Before the first scene there is no frame to certify; the replay's scene gate handles it.
        if (!current || readiness !== "ready") return diagnostics().frameIdentity;
        deterministicClock = ms;
        // A resource callback may have published this clock while we waited. The first attempt
        // still samples, and a superseding request first restores its own clock.
        if (attempted) {
          const alreadyPresented = diagnostics().frameIdentity;
          if (alreadyPresented?.clock === ms && alreadyPresented.revision === current.revision)
            return alreadyPresented;
        }
        attempted = true;
        const seen = diagnosticWakeGeneration;
        beginLocalFrame("clock");
        const at = deterministicClock ?? performance.now();
        if (lifecycle) lifecycle.phase("sample", () => { visual.applyInputs(current, at); interaction.applyHeldLift(); interaction.applyHandRaisePass(at); sampleVisual(at); });
        else { visual.applyInputs(current, at); interaction.applyHeldLift(); interaction.applyHandRaisePass(at); sampleVisual(at); }
        if (!snapshot || !tryRetainedPatch(at)) paint(current, "clock", retainedDecline);
        const candidate = asyncSubmissionRevision !== null ? asyncPresentCompletion : null;
        if (candidate) await awaitCompletion(candidate);
        assertActive();
        const identity = diagnostics().frameIdentity;
        if (identity?.clock === ms && identity.revision === state?.revision && asyncSubmissionRevision === null)
          return identity;
        if (!snapshot && asyncSubmissionRevision === null) return identity;
        if (asyncSubmissionRevision !== null && asyncPresentCompletion) continue;
        // A completion during admission is already a reason to retry. Otherwise wait for the
        // existing resource or publication callback, never for another animation frame.
        await awaitWake(seen);
      }
    } finally {
      window.clearTimeout(deadline);
      if (cancelDiagnosticClock === abort) cancelDiagnosticClock = null;
    }
  }
  globals.__mirrorSetDiagnosticClock = (ms: number | null) => {
    if (backend === "rust") return setRustDiagnosticClock(ms);
    deterministicClock = typeof ms === "number" ? ms : null;
    if (state && readiness === "ready") {
      beginLocalFrame("clock");
      const at = deterministicClock ?? performance.now();
      if (lifecycle) lifecycle.phase("sample", () => { visual.applyInputs(state!, at); interaction.applyHeldLift(); interaction.applyHandRaisePass(at); sampleVisual(at); });
      else { visual.applyInputs(state, at); interaction.applyHeldLift(); interaction.applyHandRaisePass(at); sampleVisual(at); }
      if (!tryRetainedPatch(at)) paint(state, "clock", retainedDecline);
    }
    const settle = () => new Promise((resolve) => requestAnimationFrame(() => resolve(diagnostics().frameIdentity)));
    return settle();
  };
  globals.__mirrorProductionMapProbe = (clientX: number, clientY: number) => {
    const rect = stage.getBoundingClientRect();
    let painterConsulted = false;
    const mapped = mapPointerToGame(clientX, clientY, rect, stage.clientWidth, (x, y, width) => {
      painterConsulted = true;
      return interaction.spreadPainterAt(x, y, width);
    });
    return { ...mapped, painterConsulted, backdropWidth: stage.clientWidth };
  };

  const rects = interaction.interactiveRects;
  // rustSnapshotReuse: a snapshot with no reward screen keeps that answer, and rectangles are gathered only for a
  // reward screen. Every publication installs a new snapshot object, so an answer never outlives its picture.
  const noRewardScreen = new WeakSet<DrawnSceneSnapshot>();
  // rustSceneIndex: restricts both `orderedIds` scans inside rewardFocusSnapshotFromScene to the reward-screen /
  // reward-button candidates `rewardCandidateIndex` already has on file — see the index's own comment for why this
  // is exact (the predicate reads only the node's own type). Under rustFastVerify the unrestricted full scan is
  // also run and USED, so a mismatch can never reach a caller; only the counter notices.
  const rewardFocusCandidates = (): RewardFocusCandidates | undefined =>
    rewardCandidateIndex
      ? { screens: rewardCandidateIndex.idsIn("NRewardsScreen"), buttons: rewardCandidateIndex.idsIn("NRewardButton") }
      : undefined;
  const sameRewardFocus = (a: RewardFocusSnapshot, b: RewardFocusSnapshot): boolean =>
    a.screenId === b.screenId && a.rows.length === b.rows.length && a.rows.every((row, i) => {
      const other = b.rows[i];
      return row.id === other.id && row.focused === other.focused && row.covered === other.covered &&
        (row.gameCenter === null) === (other.gameCenter === null) &&
        (row.gameCenter === null || (row.gameCenter.x === other.gameCenter!.x && row.gameCenter.y === other.gameCenter!.y));
    });
  const verifiedRewardFocus = (fastAnswer: RewardFocusSnapshot, computeTrusted: () => RewardFocusSnapshot): RewardFocusSnapshot => {
    if (!rewardCandidateIndex || !fast.verify) return fastAnswer;
    const trusted = computeTrusted();
    if (!sameRewardFocus(fastAnswer, trusted)) sceneIndexVerifyMismatches++;
    return trusted;
  };
  const rewardFocusFor = (drawn: DrawnSceneSnapshot) => {
    const candidates = rewardFocusCandidates();
    if (!fast.snapshotReuse) {
      const fastAnswer = rewardFocusSnapshotFromScene(drawn.scene.nodes, drawn.paintOrder.ids, rects(), interaction.coverAbove, candidates);
      return verifiedRewardFocus(fastAnswer,
        () => rewardFocusSnapshotFromScene(drawn.scene.nodes, drawn.paintOrder.ids, rects(), interaction.coverAbove));
    }
    if (noRewardScreen.has(drawn)) { rewardFocusSkips++; return { screenId: null, rows: [] }; }
    const fastAnswer = rewardFocusSnapshotFromScene(drawn.scene.nodes, drawn.paintOrder.ids, rects, interaction.coverAbove, candidates);
    const focus = verifiedRewardFocus(fastAnswer,
      () => rewardFocusSnapshotFromScene(drawn.scene.nodes, drawn.paintOrder.ids, rects, interaction.coverAbove));
    if (focus.screenId === null) noRewardScreen.add(drawn);
    return focus;
  };

  const renderer: MirrorRenderer = {
    reconcile(next) { lifecycle?.finish("skipped", completedDraws()); lifecycle?.begin("reconcile", next.revision, completedDraws()); lifecycle?.admit();
      if (next.sceneRewrite) paintOrderCache.invalidateAll();
      paintOrderCache.noteChanged(next, next.changedIds);
      if (rewardCandidateIndex) {
        if (next.sceneRewrite) rewardCandidateIndex.invalidateAll();
        rewardCandidateIndex.noteChanged(next.nodes, next.changedIds);
      }
      state = next; if (rustPendingAckRetry) pendingViewRevision = next.revision;
      const at = deterministicClock ?? performance.now();
      if (lifecycle) lifecycle.phase("input", () => { visual.applyInputs(next, at); interaction.applyHeldLift(); interaction.applyHandRaisePass(at); sampleVisual(at); });
      else { visual.applyInputs(next, at); interaction.applyHeldLift(); interaction.applyHandRaisePass(at); sampleVisual(at); }
      if (readiness !== "ready") { producerReasons?.noteNonBuild("reconcile-not-ready"); lifecycle?.finish("pending", completedDraws()); return false; }
      const completedAsync = asyncPresentedRevision === next.revision;
      if (completedAsync) asyncPresentedRevision = null;
      if (completedAsync) traceWarmRenderer("renderer-async-consumed", next.revision);
      const presented = completedAsync || tryRetainedWire(next, at) || paint(next, "wire", retainedDecline); if (presented) {
        next.changedIds.clear(); next.sceneRewrite = false;
        visual.advance(at);
        scheduler.armAnimation(deterministicClock ?? performance.now());
      } else {
        if (asyncSubmissionRevision === next.revision) {
          asyncAwaitingAckRevision = next.revision;
          traceWarmRenderer("renderer-awaiting-ack", next.revision);
        }
        lifecycle?.finish("pending", completedDraws());
      }
      if (presented && rustPendingAckRetry) pendingViewRevision = null;
      return presented ? undefined : false; },
    setReconcilePull(pull) { reconcilePull = pull; scheduler.setReconcilePull(pull); }, markTextureDirty() {},
    setStretch(factor) { stretch = factor; visual.setStretch(factor); if (state && readiness === "ready") paint(state, "local"); },
    setHeldCard(id, _x, y, mode) { interaction.setHeldCard(id, y, mode); }, setRaiseHandCards: interaction.setRaiseHandCards,
    setHandRaiseChrome(next) { handRaiseChrome = next; if (state && readiness === "ready") paint(state, "local"); },
    setUiScaling(enabled) { setUiScalingEnabled(enabled); }, raiseInputStamps: interaction.raiseInputStamps,
    raisedHandVisualClaimAt: interaction.raisedHandVisualClaimAt, raisedHandTouchTargetClaim: interaction.raisedHandTouchTargetClaim,
    handPresent: interaction.handPresent, handRaiseUiLayer: interaction.handRaiseUiLayer,
    handPoses: interaction.handPoses, landingLog: visual.passiveLandingLogReport, handRaiseDebug: interaction.raiseDebug,
    isCardTouchTarget: interaction.isCardTouchTarget, isHandCard: interaction.isHandCard, confirmTapTarget: interaction.confirmTapTarget,
    confirmTapAt: interaction.confirmTapAt, coverAbove: interaction.coverAbove,
    rewardFocusSnapshot: () => snapshot ? rewardFocusFor(snapshot) : { screenId: null, rows: [] },
    setConfirmCoverWatch() {}, handChoiceActive: interaction.handChoiceActive, mapDrawingToolActive: interaction.mapDrawingToolActive, interactiveRects: rects,
    viewScaleInputStamps: interaction.viewScaleInputStamps, endTurnBoxAt: interaction.endTurnBoxAt, eagerScrollTargets: interaction.eagerScrollTargets,
    isUnderNode: interaction.isUnderNode,
    consumeEffectsDirty: () => ({ shader: false, particle: false }), setStaticBackgroundShown() {},
    setStaticBackgroundSource(source, ready) { staticBackground = source; staticBackgroundReady = ready; if (!source) ready?.(false); if (state && readiness === "ready") paint(state, "local"); },
    __drainDormantHatchForTest: () => false, __drainRevealStaggerForTest: () => 0,
    touchStackAt: interaction.touchStackAt, spreadPainterAt: interaction.spreadPainterAt,
    mapNodeAt: interaction.mapNodeAt, applyLocalOffset: interaction.applyLocalOffset, scrollRenderedY: interaction.scrollRenderedY,
    dispose() { if (disposed) return; disposed = true; cancelDiagnosticClock?.("renderer disposed"); producerReasons?.disposeOpen(); asyncPresentation.dispose(); asyncPresentedRevision = null; asyncSubmissionRevision = null; asyncAwaitingAckRevision = null; asyncPresentCompletion = null; pendingViewRevision = null; if (refinementRaf !== null) cancelAnimationFrame(refinementRaf); observer?.disconnect(); stage.ownerDocument.fonts?.removeEventListener?.("loadingdone", onFontsLoaded); fontCheckCache?.dispose(); pixi?.dispose(); canvas.remove(); setStageOwnsEffectPixels(false);
      installHandPoseProbe(null, probeOwner); installLandingLogProbe(null, probeOwner); installSpreadAuditProbe(null, probeOwner);
      scheduler.dispose(); interaction.dispose(); loop.reset(); for (const clip of spineClips.values()) clip.release(); spineClips.clear();
      for (const key of ["__mirrorRendererDiagnostics", "__mirrorCanvasProfile", "__mirrorDrawListDump", "__pixiAttribution", "__pixiArmSkipGl", "__pixiArmSingleQuad", "__mirrorFrameLifecycle", "__mirrorLogicalPaint", "__mirrorFrameIdentity", "__mirrorSetDiagnosticClock", "__mirrorProductionMapProbe"]) delete globals[key]; },
  };
  return renderer;
}
