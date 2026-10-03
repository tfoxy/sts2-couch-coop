import { createClipRectView, createDrawList, createNinePatchView, createPolylineView, createQuadView, createTexturedMeshView } from "@godot-scene-web/canvas";
import type { PixiDrawListRenderer, PixiGlyphProvider, PixiTextOutcomes, PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import {
  buildDrawList, streamedAlphasOf, type AlphaOverride, type BuildDrawListOptions, type CapturedGlobal, type CosmeticOffset,
  type DrawListBuild, type LocalAnim, type SpreadRegistry
} from "@/mirror/canvas/buildDrawList";
import { baselineOf, layoutText, resolveTextSpec, type TextSpan } from "@/mirror/canvas/textLayout";
import { createColorValidator, parseSimpleRich } from "@/mirror/canvas/richSimple";
import { createPaintOrderCache } from "@/mirror/canvas/paintOrder";
import { createHiddenSubtreeMemo } from "@/mirror/canvas/hiddenSubtreeMemo";
import { createHitMemo, resolveSceneInfo, type ClipScope, type HitEntry } from "@/mirror/canvas/hitTest";
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
import { isStaticBackgroundSuppressibleRoot, spreadSceneIdentityEnv, staticBgTargetPathOf } from "@/mirror/renderer/staticBackgroundPolicy";
import { createCanvasInteractionRuntime, type OffsetPatchFrame } from "@/mirror/renderer/canvas/interactionRuntime";
import { translatedSpanRefusal } from "./translatedSpan";
import { planWireSpread, type AncestorFrame, type WireSpreadPlan } from "./wireSpreadPlan";
import { CANVAS_IDLE_ANIMATION_FPS, type DrawnSceneSnapshot } from "@/mirror/renderer/canvas/frameRuntime";
import { createCanvasVisualState, type LandingPresentation, type SampleMark } from "@/mirror/renderer/canvas/visualState";
import { CANVAS_FRAME_PARK_SLOP_MS, createCanvasFrameScheduler, type CanvasPatchSubmission } from "@/mirror/renderer/canvas/frameScheduler";
import { effectiveMirrorQuality, effectiveMirrorRenderSettings, mirrorSettings } from "@/mirror/mirrorSettings";
import { emitWarmAckTrace, warmAckTraceEnabled } from "@/mirror/warmAckTrace";
import { isShaderInputNode } from "@/mirror/shaderAttributes";
import { bakedStillForRust } from "@/mirror/bakedEffects";
import { emittedPrimitiveRows } from "@/mirror/renderer/semanticPaint";
import { nativeTextOriginCorrection, pixiShadowColor, semanticTextLayout } from "@/mirror/renderer/semanticTextLayout";
import { handRaiseChromeMatrix } from "@/mirror/handRaiseChrome";
import { installHandPoseProbe } from "@/mirror/handPoseProbe";
import { installLandingLogProbe } from "@/mirror/landingLog";
import { installSpreadAuditProbe } from "@/mirror/canvas/spreadAudit";
import { affineInverse, affineMul, type Affine } from "@/mirror/affine";
import { rendererComparisonConfig, setRendererRuntimeStatus } from "@/mirror/rendererComparison";
import { SAMPLE_LOCAL_ANIM, SAMPLE_NONE, SAMPLE_OPACITY, SAMPLE_SELF_OPACITY, SAMPLE_SOURCE, SAMPLE_TRANSFORM } from "@/mirror/canvas/tweenLoop";
import { createRustIdleLane, type RustIdleExecutor, type RustIdleLane } from "./rustIdleLane";
import { createRetainedPixiComposition, isPureTranslation, type ClipTranslation, type RetainedPixiPatch } from "./retainedComposition";
import { isCardTrailNode, isCardTrailRootNode } from "@/mirror/cardTrail";
import { resolveRustFastFlags } from "./rustFastFlags";
import { createSceneCandidateIndex } from "./sceneCandidateIndex";
import { copyTransformOverrides, overrideAncestors, sameNodeExceptTransform, sameTransformOverrides, touchesOverrideLineage } from "./heldOverrides";
import { planTextPatch, textOnlyChange } from "./textPatchPlan";
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
  patchScene(patch: ClipTranslatingScenePatch,
    diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity): PresentationResult | Promise<PresentationResult>;
  presentScene(diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity): PresentationResult | Promise<PresentationResult>;
  /**
   * `rustOffsetPatch`: `patchScene` honours `clips` (it moves a clip rect by translation). Absent or false: a patch
   * must not carry a clip move, so a moved clipper rebuilds.
   */
  readonly translatesClips?: boolean;
  /**
   * `rustTextPatch`: `patchScene` honours `texts` (it re-emits each record's command, uploading a new raster first).
   * Absent or false: a text change rebuilds.
   */
  readonly patchesText?: boolean;
  /**
   * `rustTextPatch` under `rustFastVerify`: compare each record's committed Rust command and resource with the one
   * the executor emits for it now; returns one note per mismatch.
   */
  verifyTextCommands?(records: readonly PixiTextRecord[]): string[];
  /** rustTextEvict: lifetime count of Bitmap text keys released from the JS cache and Rust GPU texture. */
  readonly rustTextEvictions?: number;
  /** rustTextEvict diagnostics: the Bitmap JS cache's current size — flat while the switch is on, unbounded
   *  growth while it is off. Always readable, regardless of the switch, so the two can be compared. */
  readonly rustTextCacheResources?: number;
  /** rustDamagePresent: the Rust renderer's cumulative damage-present counters; null while the switch is off. */
  readonly rustDamage?: { partialPresents: number; fullPresents: number; skippedPresents: number; partialPixels: number;
    partialDraws: number; verifyMismatches: number; verifyChecks: number; last: string | null } | null;
  /** rustPresent: the mode this executor's Rust engine actually presents through ("surface" unless `rustPresent`
   *  asked for another and the glue's `createWithPresent` honoured it). */
  readonly rustPresentMode?: string;
  /** rustPresent: cumulative pixels every present's blit wrote over this engine's lifetime, and the last
   *  present's own count (both 0/null until the glue reports them). */
  readonly rustBlitPixels?: { total: number; last: number | null };
};
/** A scene patch that may also translate clip rects (`ClipTranslation`, by `clipPush` index). */
export type ClipTranslatingScenePatch = import("@godot-scene-web/canvas/pixi").PixiScenePatch<string> & {
  readonly clips?: readonly ClipTranslation[];
  /** `rustTextPatch`: re-prepared text records of labels whose text changed (only to an executor that `patchesText`). */
  readonly texts?: readonly PixiTextRecord[];
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
  degradations?: Record<string, string>;
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
  // rustTextPatch: each label's paint record and insertion index from the build that filled `texts`, and that
  // build's `paintGeneration` once it published (a later build attempt rewrites `texts` and this map).
  const textBuildInputs = new Map<string, { record: OverlayRecord; insertionIndex: number }>();
  let committedTextGeneration = -1;
  const measureCanvas = stage.ownerDocument.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");
  const richColorValidator = createColorValidator(measureContext);
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
  let idleRustFrames = 0;
  let retainedDecline = "not-attempted";
  let pendingTextureSource: "resource" | "resize" = "resource";
  let committedSizeEpoch = -1;
  let committedFontVersion = -1;
  let committedTextureCount = -1;
  let resourceEpoch = 0;
  let retained = null as ReturnType<typeof createRetainedPixiComposition> | null;
  // rustOffsetPatch: the committed build's stretch factor and its spread field claimers (mode 1/2), for the
  // translated-span refusal. `spreadFieldModeByNode` is refilled by every build attempt, committed or not.
  // rustWireSpreadPatch (widened stage only): `dx` is the committed per-node spread shift, the build's value with every
  // committed wire patch's moves applied (copy-on-write: the interaction frame data of each snapshot shares it), plus
  // the floater owners and the follower lookups the committed build resolved through the registry.
  type CommittedSpread = { factor: number; claimers: ReadonlyMap<string, number>; shifted: ReadonlySet<string>;
    dx: ReadonlyMap<string, number> | null; modes: ReadonlyMap<string, number> | null; ownerReads: ReadonlySet<string>;
    followerPoints: readonly number[] };
  let committedSpread: CommittedSpread =
    { factor: 1, claimers: new Map(), shifted: new Set(), dx: null, modes: null, ownerReads: new Set(), followerPoints: [] };
  // Whether the live `spreadDxByNode`/`spreadFieldModeByNode` still hold the committed build's walk. A build attempt
  // refills them before it is known to commit; a refused or superseded one leaves another walk's values behind.
  let liveSpreadCommitted = true;
  // rustWireSpreadPatch: ONE recording registry for the renderer's life — the hidden-subtree memo keys on the
  // registry's identity, so a per-build wrapper would miss it every build. Each build points it at fresh sinks.
  let registryReads: { owners: Set<string>; followers: number[] } | null = null;
  const watchedRegistry: SpreadRegistry = {
    ownerDx: (ownerId, fallbackDx) => { registryReads?.owners.add(ownerId); return visual.spreadRegistry.ownerDx(ownerId, fallbackDx); },
    followerShift: (gx, gy) => { const dx = visual.spreadRegistry.followerShift(gx, gy); registryReads?.followers.push(gx, gy, dx); return dx; },
  };
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
  // rustDiagnostics: why the composition refused a patch, and on which animated root (capped by id).
  const compositionRefusals: Record<string, number> = {};
  const compositionRefusalRoots: Record<string, { count: number; reason: string; node: string }> = {};
  const noteCompositionRefusal = (reason: string, id: string | null) => {
    compositionRefusals[reason] = (compositionRefusals[reason] ?? 0) + 1;
    if (id === null) return;
    const row = compositionRefusalRoots[id];
    if (row) { row.count++; return; }
    if (Object.keys(compositionRefusalRoots).length >= 32) return;
    compositionRefusalRoots[id] = { count: 1, reason, node: describeNode(id) };
  };
  const describeNode = (id: string) => {
    const node = state?.nodes.get(id);
    const chain: string[] = [];
    for (let at = node; at && chain.length < 12; at = at.parentId == null ? undefined : state!.nodes.get(at.parentId))
      chain.push(`${at.name}${at.visible ? "" : "(hidden)"}${visual.transformOverrides.has(at.id) ? "[override]" : ""}`);
    return node === undefined ? `${id} (absent)`
      : `${id} ${node.nodeType ?? "?"} ${chain.join(" < ")}${node.parentId != null && !state!.nodes.has(node.parentId) ? " < (orphan)" : ""}` +
        `${snapshot?.build.order.entries.has(id) ? "" : " [not-in-order]"}${snapshot?.build.localAnimFrames.has(id) ? " [frame]" : ""}` +
        `${snapshot?.build.localAnimFrames.get(id)?.spreadRebased ? " [rebased]" : ""}`;
  };
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
  let heldOverridePatches = 0;
  // rustFastVerify accumulators, one per patch family that claims exactness (held overrides, cosmetic offsets).
  // Each keeps its own ring of the builds and patches that led up to a run, so one family's log does not depend on
  // the other's switch.
  // `kinds` counts mismatches by what disagreed (a command kind, `text`, `hit`, `captured`, `spread`, ...).
  type VerifyStats = { runs: number; mismatches: number; maxError: number; firstMismatch: string | null; log: HeldVerifyEntry[];
    recent: string[]; kinds: Record<string, number> };
  const verifyStats = (): VerifyStats => ({ runs: 0, mismatches: 0, maxError: 0, firstMismatch: null, log: [], recent: [], kinds: {} });
  const heldVerify = verifyStats(), offsetVerify = verifyStats();
  // rustWireSpreadPatch: its own family, so a run reports the spread re-poses apart from the offset translations.
  const spreadVerify = verifyStats();
  // rustTweenRootPatch: likewise its own family.
  const tweenVerify = verifyStats();
  // rustTextPatch: a text-only wire change re-prepared and patched in place, its own family too.
  const textVerify = verifyStats();
  let textPatches = 0, textPatchedRecords = 0;
  const textPatchDeclines: Record<string, number> = {};
  // rustOffsetPatch: what a translate patch publishes beyond its commands (the offsets and raise plan it drew and the
  // captured globals it moved), plus its planned inputs under verify. A wire translation of captured nodes adds its
  // recomputed entries to `captures` and sets `wireCaptured`.
  // rustWireSpreadPatch: `spread` is set on every patch whose wire spans the switch re-posed (even with no shift
  // change), and holds each span node's new spread shift where it moved along the field.
  type PatchSidecar = { frame?: OffsetPatchFrame; captures?: Map<string, CapturedGlobal>; moved?: ReadonlySet<string>;
    verify?: HeldPatchInputs; wireCaptured?: boolean; spread?: Map<string, number>; spreadSpans?: number;
    // rustTweenRootPatch: the override bank the patch drew (committed on publication), how many roots it re-posed,
    // and whether an open landing may ride it (no local animation or offset translation moved a landing node).
    tween?: { overrides: Map<string, readonly number[]>; roots: number };
    /** rustTweenRootPatch: an open landing may ride this patch (every landing node it moves was recomputed). */
    landingPatchable?: boolean;
    /** rustTextPatch: the labels whose re-prepared records this patch carries, and its verify inputs. */
    textOwners?: ReadonlySet<string>; textVerify?: HeldPatchInputs };
  const patchSidecars = new WeakMap<RetainedPixiPatch, PatchSidecar>();
  let offsetPatches = 0, offsetPatchedNodes = 0, wireCapturedPatches = 0;
  let wireSpreadPatches = 0, wireSpreadSpans = 0, wireSpreadShifted = 0, wireSpreadVisited = 0;
  // `rustPhaseTiming=1`: the wire reconcile's per-span planning loop and the spread bank's publication.
  let wireSpanLoopMs = 0, wireSpreadPublishMs = 0;
  const wireSpreadDeclines: Record<string, number> = {};
  let tweenRootPatches = 0, tweenRootsPatched = 0, tweenRootVisited = 0;
  const tweenDeclines: Record<string, number> = {};
  const offsetDeclines: Record<string, number> = {};
  // Which node types a refused translation tripped on (`offset-clip` / `offset-view-scale` / `offset-anim`).
  const offsetDeclineTypes: Record<string, number> = {};
  const noteDeclineType = (reason: string, node: MirrorNode | undefined) => {
    const key = `${reason}:${node ? nodeTypeLeaf(node.nodeType) : "?"}:${node?.name ?? "?"}`;
    offsetDeclineTypes[key] = (offsetDeclineTypes[key] ?? 0) + 1;
  };
  const heldOverrideDeclines: Record<string, number> = {};
  // rustFastVerify: every verify run that found a mismatch, with all of its notes and the builds and patches that
  // led up to it (a short ring, recorded under verify only). Both bounded so a long session cannot grow them.
  type HeldVerifyEntry = { run: number; revision: number; clock: number | null; notes: string[]; recent: string[] };
  const noteHeldEvent = (event: () => string) => {
    if (!fast.verify || (!fast.heldOverridePatch && !fast.offsetPatch && !fast.wireSpreadPatch && !fast.tweenRootPatch &&
      !fast.textPatch)) return;
    const text = event();
    for (const stats of [fast.heldOverridePatch ? heldVerify : null, fast.offsetPatch ? offsetVerify : null,
      fast.wireSpreadPatch ? spreadVerify : null, fast.tweenRootPatch ? tweenVerify : null, fast.textPatch ? textVerify : null]) {
      if (!stats) continue;
      stats.recent.push(text);
      if (stats.recent.length > 24) stats.recent.shift();
    }
  };
  // The scheduler's record of each submitted patch, handed back when the patch commits or is lost.
  const patchSubmissions = new WeakMap<RetainedPixiPatch, CanvasPatchSubmission | null>();
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
  const failedRoleFamilies = new Set<string>();
  const textDegradations = new Map<string, string>();
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
  // rustIdleInRust: the Rust renderer presents pure idle frames itself (`rustIdleLane.ts`). `commitSerial` moves on
  // every published build or patch; the lane's installed descriptors belong to one.
  let idleLane: RustIdleLane | null = null;
  let commitSerial = 0;
  /** The committed snapshot after the lane replays any pose Rust drew since (hit tests read its `mFinal`). */
  const syncedSnapshot = () => { idleLane?.sync(); return snapshot; };
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
    paintOrder: () => snapshot?.paintOrder ?? null, hitEntries: () => syncedSnapshot()?.hitEntries ?? [], capturedGlobal: (id) => snapshot?.capturedGlobals.get(id),
    cosmeticOffsetDy: (id) => interaction?.cosmeticOffsets.get(id)?.dy ?? 0,
    effectivelyVisible: (node) => interaction?.liveEffectivelyVisible(node) ?? node.visible,
    isLandingTarget: (id) => interaction?.handHolderIds.has(id) ?? false,
    onTransformArm: (id, at) => interaction?.noteTransformArmPose(id, at), onNodePresent: (node) => interaction?.noteNodePresent(node),
    onNodeRemoved: (id) => interaction?.noteNodeRemoved(id), onRewrite: () => interaction?.noteRewrite(), onFlights: () => {},
  }, { clockOriginMs: deterministicClock ?? performance.now(), now: () => deterministicClock ?? performance.now(), spreadAuditEnabled, noteIdlePeriod: () => {},
    // rustCoalescedBuilds / rustOffsetPatch: a frame may sample an intent-frame swap or an opacity step and draw
    // nothing (a yielding tick, a patch that never presents), so either stays open until a committed frame drew it.
    retainSourceSwaps: fast.coalescedBuilds || fast.offsetPatch });
  /** The open source swaps each submitted patch drew, settled when it commits. */
  const patchSourceMarks = new WeakMap<RetainedPixiPatch, SampleMark | null>();
  let lastSampleClock: number | null = null;
  const sampleVisual = (at: number) => { lastSampleClock = at; visual.sample(at); };
  const spreadDxByNode = visual.spreadDxByNode;
  const spreadFieldModeByNode = visual.spreadFieldModeByNode;
  const loop = visual.loop;
  interaction = createCanvasInteractionRuntime({
    state: () => state, snapshot: syncedSnapshot, now: () => deterministicClock ?? performance.now(), disposed: () => disposed,
    stage, stageScale: () => stage.getBoundingClientRect().width / Math.max(1, stage.clientWidth), designWidth: () => stage.clientWidth,
    spreadFactor: () => visual.spreadFactor, spreadDxByNode, spreadFieldModeByNode, loop: () => loop, streamedGlobalInto: visual.streamedGlobalInto,
    rebuildAndPaint: () => { if (state && readiness === "ready") paint(state, "local"); }, armAnimation: () => scheduler.armAnimation(performance.now()),
    // rustCoalescedBuilds: client-only changes become one per-frame build request (see frameScheduler.ts).
    // Before readiness a change is dropped exactly as `rebuildAndPaint` drops it: the first frame builds it anyway.
    requestBuild: fast.coalescedBuilds
      ? (urgent, offsetOnly) => state && readiness === "ready" ? scheduler.requestBuild(urgent, offsetOnly) : "deferred" : undefined,
    builds: () => buildEpoch, paintedFrames: () => pixi?.stats.completedFrames ?? 0,
    sceneIndex: fast.sceneIndex, sceneIndexVerify: fast.verify,
    raiseIndexCache: fast.raiseIndexCache, raiseIndexCacheVerify: fast.verify,
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
      tryPatchAndPaint: (at) => tryRetainedPatch(at),
      presentIdleFrame: backend === "rust" && retainedMode && fast.idleInRust ? (at) => presentIdleFrame(at) : undefined,
      runBuild: (next, requested) => requested ? paint(next, "local", "coalesced-request") : paint(next, "animation", retainedDecline),
      syncOverlay() {}, paintAction() {},
      settleLanding: () => {}, rebuildAndPaintTexture: () => state && readiness === "ready" ? deferredPaint(state) : false,
    },
    // rustCoalescedBuilds decides; rustProducerReasons alone only counts work per frame for a switch-off arm.
    // rustOffsetPatch: a moved ramp or an offset-only request may be presented by a translate patch.
    rampPatchable: fast.offsetPatch && retainedMode,
    // rustIdleScheduler: a steady idle frame is one rAF task (no park timer, no posted epoch close).
    idleScheduler: fast.idleScheduler,
    // rustIdleDueFrame: no rAF on a vsync the passive deadline will not admit; the park timer books the due frame.
    idleDueFrame: fast.idleDueFrame,
    coalesce: fast.coalescedBuilds || producerReasonMode ? {
      enabled: fast.coalescedBuilds,
      localBuild: () => {
        if (!state || readiness !== "ready") return;
        // An offset-only request is served by a translate patch when one plans (an async submission counts).
        if (fast.offsetPatch && !scheduler.buildRequired && snapshot) {
          const at = deterministicClock ?? performance.now();
          if (tryRetainedPatch(at) || retainedDecline === "async-in-flight") return;
        }
        paint(state, "local");
      },
      buildBlocked: () => backend === "rust" && asyncSubmissionRevision !== null,
    } : undefined,
  });
  if (backend === "rust" && retainedMode && fast.idleInRust) idleLane = createRustIdleLane({
    visual, composition: () => retained,
    executor: () => (pixi as unknown as Partial<RustIdleExecutor> | null)?.idleAnims ? pixi as unknown as RustIdleExecutor : null,
    commitKey: () => commitSerial,
    blocked: idleLaneBlocked,
    begin: () => scheduler.noteFrameWork("patch"),
    settle: (submission, committed) => scheduler.settlePatch(submission as CanvasPatchSubmission | null, committed, !committed),
    publishHits(hits) {
      for (const { entry, matrix } of hits) entry.mFinal = matrix;
      const previous = snapshot!;
      snapshot = { ...previous };
      interaction.publishPatch(previous, snapshot);
    },
    invalidate(reason) { retainedValid = false; committedOverrides = null; producerReasons?.noteNonBuild(reason); scheduler.scheduleTexturePaint(); },
    verify: fast.verify,
  });
  /**
   * rustCoalescedBuilds: a presentation that settled without committing must not strand a request it blocked.
   * Called on every settle path. It cannot become a retry loop: the build it re-arms consumes the request when it
   * starts, so a second refusal finds no request to re-arm for (a resource wait then rests on that resource's wake).
   */
  const rearmHeldRequest = () => {
    // rustOffsetPatch: a frame carried while the presentation was in flight waits for this settlement as well.
    if (disposed || !(scheduler.buildRequested || scheduler.carryPending)) return;
    scheduler.armAnimation(deterministicClock ?? performance.now());
  };
  /** A client-only change that needs a fresh list: one coalesced request, or (switch off) a build right here. */
  const paintLocal = () => {
    if (!state || readiness !== "ready") return;
    if (fast.coalescedBuilds) scheduler.requestBuild(false);
    else paint(state, "local");
  };
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

  /**
   * The Rust/text-prep-cache half of `semanticText`: prepare one label's text records without publishing them. A
   * refusal names why (the build records it as the node's semantic failure). `rustTextPatch` calls this for a
   * label whose text changed, with the committed build's paint record, and publishes nothing on a refusal.
   */
  function prepareSemanticTextRecords(input: Pick<NodePaintInput, "node" | "nodes">, record: OverlayRecord,
    insertionIndex: number): { records: PixiTextRecord[] } | { refusal: string } {
    const node = input.node;
    const fonts = document.fonts;
    const fontReady = (cssFont: string, text: string): boolean =>
      fontCheckCache ? fontCheckCache.check(cssFont, text, fontVersion, fast.verify) : fonts!.check(cssFont, text);
    const nodes = input.nodes ?? state?.nodes ?? new Map();
    const compute = (): PreparedText | TextPrepRefusal => {
      const resolved = resolveSemanticTextSpec(node, nodes, backend === "rust", failedRoleFamilies,
        richColorValidator, backend === "rust");
      if ("refusal" in resolved) return resolved;
      if (!measureContext) return { refusal: "no-measure-context" };
      nativeLayouts++;
      return buildPreparedText(resolved, fontVersion, node.font!,
        (value) => measureContext.measureText(value).width,
        (cssFont) => { measureContext.font = cssFont; measureContext.letterSpacing = "0px";
          const sample = measureContext.measureText("Mg");
          return { ascent: sample.fontBoundingBoxAscent || sample.actualBoundingBoxAscent,
            descent: sample.fontBoundingBoxDescent || sample.actualBoundingBoxDescent }; },
        (face, value) => { measureContext.font = face.cssFont;
          measureContext.letterSpacing = `${face.spacingPx}px`; return measureContext.measureText(value).width; },
        (url) => { pixi?.prefetch(url); return pixi?.textureSize(url) ??
          (pixi?.textureFailureDetails().some((item) => item.startsWith(`${url}:`)) ? { width: 0, height: 0 } : null); });
    };
    const prepared = textPrepCache
      ? textPrepCache.resolve(node, nodes, fontVersion, backend === "rust" ? `${textMode}:${mirrorSettings.textMethod}` : textMode, fast.verify, compute) : compute();
    if ("refusal" in prepared) return { refusal: prepared.refusal };
    const losses = [...prepared.degradations ?? []];
    if (prepared.fallbackRoles?.length) losses.push(`font-role-fallback:${prepared.fallbackRoles.join(",")}`);
    if (losses.length) textDegradations.set(node.id, losses.join(" | "));
    const fontsToCheck = [{ cssFont: prepared.spec.cssFont, text: prepared.spec.text,
      family: prepared.spec.family, role: false },
      ...Object.values(prepared.roleFaces ?? {}).filter((face) => face !== undefined).map((face) =>
        ({ cssFont: face.cssFont, text: prepared.spec.text, family: face.font.family, role: true }))];
    let waitingForFont = false;
    for (const face of fontsToCheck) {
      if (!fonts || fontFailed.has(face.cssFont) || failedRoleFamilies.has(face.family)) continue;
      if (fontPending.has(face.cssFont)) { waitingForFont = true; continue; }
      if (fontReady(face.cssFont, face.text)) continue;
      waitingForFont = true;
      fontPending.add(face.cssFont);
      void loadMirrorFont(fonts, face.cssFont, face.text, face.family)
        .then(() => { if (!disposed) { fontVersion++; textLayoutCache.clear(); } })
        .catch(() => { if (!disposed) {
          if (face.role) failedRoleFamilies.add(face.family);
          else fontFailed.add(face.cssFont);
          fontVersion++; textLayoutCache.clear();
        } })
        .finally(() => { fontPending.delete(face.cssFont); wakeForResource(); });
    }
    if (fontFailed.has(prepared.spec.cssFont)) return { refusal: "font-load" };
    if (backend === "rust" && waitingForFont) return { refusal: "font-pending" };
    const nativeParts = composePreparedTextRecords(prepared, node.id, insertionIndex, record, canvasBlend(node));
    if (textMode === "native" || nativeParts.length === 0) return { records: nativeParts };
    const carrierKey = `${node.id}:glyph`;
    const preparedGlyph = preparePixiGlyph(glyphRegistry, prepared.spec, prepared.layout, node.font!,
      record.transform, dpr, prepared.layoutKey, canvasBlend(node) === 0);
    return { records: [{ ...nativeParts[0], key: carrierKey, transform: [...record.transform],
      text: prepared.spec.text, glyph: preparedGlyph.glyph, fallbackReason: preparedGlyph.fallbackReason,
      nativeFallback: nativeParts.map((part) => ({ ...part, alpha: 1, tint: 0xffffff, blend: 0 })) }] };
  }

  function semanticText(input: NodePaintInput, record: OverlayRecord, insertionIndex: number): boolean {
    const node = input.node;
    ensureNodeFonts(node);
    // Both caches are independent switches (rustFastFlags umbrella semantics), so `fontReady` is shared by both
    // branches below rather than duplicated: with `fontCheckCache` off it is exactly `fonts.check(...)`, same as
    // before this round: `fontReady` is only ever called from inside an `if (fonts && ...)` guard.
    const fonts = document.fonts;
    const fontReady = (cssFont: string, text: string): boolean =>
      fontCheckCache ? fontCheckCache.check(cssFont, text, fontVersion, fast.verify) : fonts!.check(cssFont, text);

    if (backend === "rust" || textPrepCache) {
      const prepared = prepareSemanticTextRecords(input, record, insertionIndex);
      if ("refusal" in prepared) { semanticFailures.set(node.id, prepared.refusal); return false; }
      const textStart = texts.length;
      texts.push(...prepared.records);
      for (let i = textStart; i < texts.length; i++) {
        const text = texts[i];
        textOwners.set(text.key, node.id);
        const keys = textKeysByOwner.get(node.id) ?? [];
        keys.push(text.key);
        textKeysByOwner.set(node.id, keys);
      }
      // rustTextPatch: the paint record this label was prepared from, by value, for a later text-only change.
      if (backend === "rust" && prepared.records.length)
        textBuildInputs.set(node.id, { record: { ...record, transform: [...record.transform] as Affine }, insertionIndex });
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
    if (backend === "rust" && (record.kind === "shader" || record.kind === "particles")) {
      const still = bakedStillForRust(input.node);
      if (!still) return;
      const box = still.box;
      const x = box === "localRect" ? 0 : box.x;
      const y = box === "localRect" ? 0 : box.y;
      const m = record.transform;
      const q = scratch.quad;
      q.m[0]=m[0]; q.m[1]=m[1]; q.m[2]=m[2]; q.m[3]=m[3];
      q.m[4]=m[0]*x+m[2]*y+m[4]; q.m[5]=m[1]*x+m[3]*y+m[5];
      q.w=box === "localRect" ? record.w : box.width;
      q.h=box === "localRect" ? record.h : box.height;
      q.srcX=0; q.srcY=0; q.srcW=still.sourceWidth; q.srcH=still.sourceHeight;
      const alpha=record.opacity*still.opacityScale;
      q.a=alpha; q.r=record.tintR*alpha; q.g=record.tintG*alpha; q.b=record.tintB*alpha;
      q.blend=still.additive ? 1 : canvasBlend(input.node);
      q.flipH=false; q.flipV=false; q.hasColorMatrix=false;
      target.pushQuad(q, still.url);
      return;
    }
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
  const forceEffectStillOverlay: BuildDrawListOptions["forceEffectStillOverlay"] = backend === "rust"
    ? (node) => bakedStillForRust(node) !== null ? (node.particleSpec != null ? "particles" : "shader") : null
    : undefined;

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
    // rustIdleInRust: the build reads the committed hit entries (tip scale); they must hold the drawn idle pose.
    idleLane?.sync();
    const profileIdentity = profile?.begin("full-build", next.revision, ++profileBuildAttempts);
    const traceId = nextTraceFrame();
    // Rust presentation is asynchronous. Keep one scene in flight; newer state remains in `state` and is
    // reconciled after this presentation settles, while repeated scheduler wakeups cannot invalidate its ticket.
    if (backend === "rust" && asyncSubmissionRevision !== null) {
      if (profileIdentity) profile!.outcome(profileIdentity, "superseded", "full-build-deferred-in-flight");
      producerReasons?.noteNonBuild("full-build-deferred-in-flight");
      return false;
    }
    // A full build of the current state serves any outstanding build request (rustCoalescedBuilds).
    scheduler.noteFrameWork("build");
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
    const buildGeneration = ++paintGeneration;
    texts.length = 0;
    textOwners.clear();
    textKeysByOwner.clear();
    textBuildInputs.clear();
    semanticFailures.clear();
    textDegradations.clear();
    const capturedGlobals = new Map(); const captureIds = new Set<string>(); interaction.collectCaptureIds(captureIds); visual.collectLandingCaptureIds(captureIds);
    visual.prepareBuild(next); interaction.prepareBuild(); spreadDxByNode.clear(); spreadFieldModeByNode.clear();
    liveSpreadCommitted = false;
    const candidateSourceMark = visual.sampleMark();
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
    // rustWireSpreadPatch: what this build resolved through the registry, which a later wire patch must not move.
    const spreadWatch = fast.wireSpreadPatch && visual.spreadFactor !== 1;
    const ownerReads = new Set<string>();
    const followerPoints: number[] = [];
    registryReads = spreadWatch ? { owners: ownerReads, followers: followerPoints } : null;
    const buildRegistry: SpreadRegistry = spreadWatch ? watchedRegistry : visual.spreadRegistry;
    // The build draws a BY-VALUE copy of the overrides, in every configuration. The walk keeps an override array as
    // the node's `gRaw` (so its paint input's global, hit `mFinal` and captured globals ALIAS it), and the tween sweep
    // rewrites that array in place every frame: the landing probe, the hand probe and a later patch would all read the
    // next sample as the committed pose.
    const builtOverrides = copyTransformOverrides(visual.transformOverrides);
    const buildScene = () => buildDrawList(next, list, { resetList: false, scratch, paintOrderCache,
      spreadAudit: visual.spreadAudit,
      profilePhase: profileIdentity ? (phase, run) => profile!.span(profileIdentity, `couch.draw-${phase}`, run) : undefined,
      structureReuse: paintOrderReuse, hitMemo, skipRoots,
      skipHiddenHitCandidates: rustSkipHiddenHitCandidates,
      hiddenSubtreeMemo: hiddenMemo, hiddenSubtreeMemoVerify: fast.verify, hiddenSubtreeMemoSpread: fast.hiddenMemoSpread,
      // The wire-span refusal (`translatedSpan`) reads them in every configuration.
      trackViewScaleCandidates: true,
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
      spreadRegistry: buildRegistry, spreadDxOut: spreadDxByNode, spreadFieldModeOut: spreadFieldModeByNode,
      transformOverrides: builtOverrides.size ? builtOverrides : null,
      alphaOverrides: visual.alphaOverrides.size ? visual.alphaOverrides : null,
      localAnims: visual.localAnims.size ? visual.localAnims : null,
      frameSubstitutes: visual.frameSubstitutes.size ? visual.frameSubstitutes : null,
      viewScaleEnv: visual.viewScaleEnv, tipScaleEnv: visual.tipScaleEnv, pinnedLocals: visual.pinnedLocals,
      captureGlobals: captureIds.size ? { ids: captureIds, out: capturedGlobals } : null,
      cosmeticOffsets: interaction.cosmeticOffsets, semanticText, semanticOverlay, forceEffectStillOverlay,
      assert: false });
    // rustHeldOverridePatch: the overrides this build applies, by value, banked when its frame publishes.
    const appliedOverrides = fast.heldOverridePatch ? builtOverrides : null;
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
      sampleClock: lastSampleClock ?? candidateClock, buildEpoch, frameTask: scheduler.frameTask, sizeEpoch: asyncPresentationSizeEpoch,
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
    const candidateSpread: CommittedSpread = { factor: visual.spreadFactor, claimers: new Map<string, number>(),
      shifted: new Set<string>(), dx: null, modes: null, ownerReads, followerPoints };
    if (candidateSpread.factor !== 1) {
      // rustWireSpreadPatch re-walks a moved span itself; the claim sets are the refusal's input when it is off. The
      // interaction frame data already holds a by-value copy of this build's shifts: the bank shares it.
      if (spreadWatch) { candidateSpread.dx = interactionCandidate.spreadDxByNode; candidateSpread.modes = interactionCandidate.spreadFieldModeByNode; }
      else {
        for (const [id, mode] of spreadFieldModeByNode) if (mode !== 0) (candidateSpread.claimers as Map<string, number>).set(id, mode);
        for (const [id, dx] of spreadDxByNode) if (dx !== 0) (candidateSpread.shifted as Set<string>).add(id);
      }
    }
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
              : undefined, ...(rustDiagnosticMode ? { onPatchRefused: noteCompositionRefusal } : {}),
            ...compositionLaziness } : undefined);
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
            rearmHeldRequest();
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
            rearmHeldRequest();
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
          rearmHeldRequest();
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
          rearmHeldRequest();
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
    commitSerial++;
    idleLane?.committed(true);
    committedTextGeneration = buildGeneration;
    committedSpread = candidateSpread;
    liveSpreadCommitted = true;
    visual.settleSamples(candidateSourceMark);
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
    for (const { entry, matrix, gameMatrix, spreadDx } of patch.hits) {
      entry.mFinal = matrix;
      if (gameMatrix) entry.mGame = gameMatrix;
      if (spreadDx !== undefined) entry.spreadDx = spreadDx;
    }
    retained!.commit(patch);
    commitSerial++;
    idleLane?.committed(false);
    if (patch.clips?.length) translateHitClips(previous.hitEntries, patch.clips);
    // rustTextPatch: the re-prepared records become the committed ones (same keys, owners and order).
    if (patch.texts?.length) {
      const replaced = new Map(patch.texts.map((record) => [record.key, record]));
      for (let i = 0; i < texts.length; i++) {
        const record = replaced.get(texts[i].key);
        if (record) texts[i] = record;
      }
    }
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
    const sidecar = patchSidecars.get(patch);
    visual.settleSamples(patchSourceMarks.get(patch) ?? null);
    let capturedGlobals = previous.capturedGlobals;
    if (sidecar?.captures?.size) {
      // Replaced, never edited: the previous snapshot and any landing candidate keep the entries they read.
      const moved = new Map(previous.capturedGlobals);
      for (const [id, captured] of sidecar.captures) moved.set(id, captured);
      capturedGlobals = moved;
    }
    snapshot = { ...previous, capturedGlobals, stateRevision: wire?.revision ?? previous.stateRevision };
    // rustWireSpreadPatch: the moved shifts become the committed bank (replaced, never edited: the previous snapshot's
    // frame data keeps the map it was drawn with) and the live map the input side reads between builds.
    let spreadBank: ReadonlyMap<string, number> | undefined;
    const bankStarted = rustPhaseTimingMode ? performance.now() : 0;
    if (sidecar?.spread?.size && committedSpread.dx) {
      const moved = new Map(committedSpread.dx);
      // A build attempt since the commit left its own walk in the live maps: put the committed one back first.
      if (!liveSpreadCommitted) {
        spreadDxByNode.clear(); for (const [id, dx] of committedSpread.dx) spreadDxByNode.set(id, dx);
        spreadFieldModeByNode.clear(); for (const [id, mode] of committedSpread.modes ?? []) spreadFieldModeByNode.set(id, mode);
        liveSpreadCommitted = true;
      }
      for (const [id, dx] of sidecar.spread) { moved.set(id, dx); spreadDxByNode.set(id, dx); }
      committedSpread = { ...committedSpread, dx: moved };
      spreadBank = moved;
    }
    interaction.publishPatch(previous, snapshot, sidecar?.frame, spreadBank);
    if (rustPhaseTimingMode) wireSpreadPublishMs += performance.now() - bankStarted;
    landingCandidate?.publish();
    refinementPending = refinementRaf !== null;
    refinementFailure = null;
    publishTextOutcome();
    if (startupEnabled) noteStartupReady(snapshot.stateRevision);
    drawnClock = at;
    signalDiagnosticWake();
    noteHeldEvent(() => `patch r${snapshot!.stateRevision} held=${heldPatches.has(patch) ? 1 : 0} wire=${wire?.changedIds.size ?? 0} ` +
      `primitives=${patch.primitives.length} alphas=${patch.primitives.filter((item) => item.alpha !== undefined).length} groups=${patch.groups.length}` +
      `${patch.rootTranslations?.size ? ` roots=${[...patch.rootTranslations].map(([id, [x, y]]) => `${id}@${x.toFixed(2)},${y.toFixed(2)}`).join(";")}` : ""}` +
      `${sidecar?.moved?.size ? ` moved=${sidecar.moved.size}` : ""}`);
    if (heldPatches.has(patch)) { heldOverridePatches++; const inputs = heldPatches.get(patch); if (inputs) verifyHeldOverridePatch(inputs, heldVerify, false, new Set()); }
    // Counted on acceptance only: a plan that was refused or never presented moved nothing.
    if (sidecar?.frame) { offsetPatches++; offsetPatchedNodes += sidecar.moved?.size ?? 0; }
    if (sidecar?.spreadSpans) { wireSpreadPatches++; wireSpreadSpans += sidecar.spreadSpans; wireSpreadShifted += sidecar.spread?.size ?? 0; }
    if (sidecar?.tween) { tweenRootPatches++; tweenRootsPatched += sidecar.tween.roots; committedOverrides = sidecar.tween.overrides; }
    // A patch carrying both an offset translation and a re-posed span reports to the offset family; a tween re-pose
    // to its own (with a wire span beside it too).
    if (sidecar?.verify) verifyHeldOverridePatch(sidecar.verify,
      sidecar.tween ? tweenVerify : sidecar.spreadSpans && !sidecar.frame ? spreadVerify : offsetVerify,
      true, sidecar.moved ?? new Set(), sidecar.spreadSpans || sidecar.tween ? sidecar.spread ?? new Map() : undefined);
    if (sidecar?.wireCaptured) wireCapturedPatches++;
    if (patch.texts?.length) {
      textPatches++; textPatchedRecords += patch.texts.length;
      if (sidecar?.textVerify) verifyHeldOverridePatch(sidecar.textVerify, textVerify, false, new Set(), undefined, sidecar.textOwners);
    }
    scheduler.settlePatch(patchSubmissions.get(patch) ?? null, true);
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
    patchSubmissions.set(patch, scheduler.noteFrameWork("patch"));
    const moves = patch.primitives.length > 0 || patch.groups.length > 0 || (patch.clips?.length ?? 0) > 0 ||
      (patch.texts?.length ?? 0) > 0;
    const mode = moves ? "scene-patch" : "present-only";
    const profileIdentity = profile?.begin(mode === "scene-patch" ? "retained-patch" : "present-only", state?.revision);
    const phaseSubmissionId = rustExecutionPhaseMode
      ? producerReasons!.startRetained(state?.revision ?? null, mode) : undefined;
    const phaseEvent = phaseSubmissionId === undefined ? undefined
      : (event: ProducerExecutorEvent) => producerReasons!.retainedEvent(phaseSubmissionId, event);
    const scenePatch: ClipTranslatingScenePatch = { primitives: patch.primitives, groups: patch.groups,
      ...(patch.clips?.length ? { clips: patch.clips } : {}), ...(patch.texts?.length ? { texts: patch.texts } : {}) };
    const submit = () => moves
      ? pixi!.patchScene(scenePatch, phaseEvent, profileIdentity) : pixi!.presentScene(phaseEvent, profileIdentity);
    const tracedSubmit = traceId === null ? submit : () => tracePixi(traceId, submit);
    try { return { result: lifecycle ? lifecycle.phase("pixi", tracedSubmit) : tracedSubmit(), phaseSubmissionId }; }
    catch (error) {
      if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
      throw error;
    }
  }

  /** A submitted patch that will never present gives back what its submission took (see `settlePatch`). */
  const patchLost = (patch: RetainedPixiPatch, buildFollows = false) =>
    scheduler.settlePatch(patchSubmissions.get(patch) ?? null, false, buildFollows);

  function trackAsyncRetainedPatch(result: Promise<PresentationResult>, patch: RetainedPixiPatch, at: number,
    wire?: MirrorState, phaseSubmissionId?: number, landingCandidate?: LandingPresentation): void {
    const revision = wire?.revision ?? state?.revision;
    if (revision === undefined || revision === null || asyncSubmissionRevision !== null) {
      if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "superseded");
      patchLost(patch);
      return;
    }
    const ticket = asyncPresentation.begin(revision);
    const sizeEpoch = asyncPresentationSizeEpoch;
    const candidateLandingGeneration = visual.landingGeneration;
    if (rustDiagnosticMode) retainedAsyncSubmitted++;
    asyncSubmissionRevision = revision;
    asyncPresentCompletion = Promise.resolve(result).then((outcome) => {
      if (!asyncPresentation.current(ticket)) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(
        phaseSubmissionId, disposed ? "disposed" : "superseded"); patchLost(patch); return; }
      if (state?.revision !== revision || asyncPresentationSizeEpoch !== sizeEpoch ||
        visual.landingGeneration !== candidateLandingGeneration) {
        if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "superseded");
        producerReasons?.noteNonBuild("retained-presentation-stale");
        if (asyncSubmissionRevision === revision) asyncSubmissionRevision = null;
        patchLost(patch);
        retainedValid = false; committedOverrides = null;
        if (asyncAwaitingAckRevision === revision) asyncAwaitingAckRevision = null;
        scheduler.scheduleTexturePaint();
        rearmHeldRequest();
        return;
      }
      if (!resultPresented(outcome)) {
        if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
        producerReasons?.noteNonBuild("retained-presentation-refused");
        retainedPatchFallbacks++;
        retainedValid = false; committedOverrides = null;
        if (asyncSubmissionRevision === revision) asyncSubmissionRevision = null;
        patchLost(patch);
        const reason = outcome && typeof outcome === "object" ? (outcome as PresentationResult).reason : undefined;
        if (reason === "retained patch requires full scene admission") {
          if (asyncAwaitingAckRevision === revision && reconcilePull) {
            asyncAwaitingAckRevision = null;
            traceWarmRenderer("renderer-pull-recovery", revision);
            reconcilePull.now();
          } else if (state && readiness === "ready") paint(state, "recovery", "async-full-admission");
          rearmHeldRequest();
          return;
        }
        if (reason && !/pending|resource|in flight/i.test(reason)) publishStatus("failed", reason);
        if (asyncAwaitingAckRevision === revision && reconcilePull) {
          asyncAwaitingAckRevision = null;
          traceWarmRenderer("renderer-pull-refused", revision);
          reconcilePull.now();
        } else scheduler.scheduleTexturePaint();
        rearmHeldRequest();
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
      rearmHeldRequest();
      startupCompletionHook?.();
    }).catch((error: unknown) => {
      if (!asyncPresentation.current(ticket)) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(
        phaseSubmissionId, disposed ? "disposed" : "superseded"); patchLost(patch); return; }
      if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
      producerReasons?.noteNonBuild("retained-presentation-error");
      retainedPatchFallbacks++;
      retainedValid = false; committedOverrides = null;
      if (asyncSubmissionRevision === revision) asyncSubmissionRevision = null;
      patchLost(patch);
      publishStatus("failed", error instanceof Error ? error.message : String(error));
      scheduler.scheduleTexturePaint();
      rearmHeldRequest();
    });
  }

  function tryRetainedWire(next: MirrorState, at: number): boolean {
    // rustIdleInRust: plan against what Rust shows, not the last pose this side committed.
    idleLane?.sync();
    const refuse = (reason: string) => { retainedDecline = reason; return false; };
    if (!retainedMode || !retainedValid || !retained || !pixi || !snapshot) return refuse("invalid-retained-state");
    if (next.sceneRewrite) return refuse("scene-rewrite");
    // rustCoalescedBuilds: an outstanding client-only change needs the full build a patch would skip.
    if (scheduler.buildRequired) return refuse("build-requested");
    // rustOffsetPatch: the sample plan below translates moved offsets instead.
    if (!fast.offsetPatch && (interaction.offsetPending || !interaction.cosmeticOffsetsMatch(snapshot))) return refuse("offset-pending");
    retainedDecline = "plan-unsupported";
const traceId = nextTraceFrame();
    const planStarted = rustPhaseTimingMode ? performance.now() : 0;
    const plan = traceId === null ? () => planRetainedSample(next) : () => tracePhase(traceId, "patch", () => planRetainedSample(next));
    const patch = lifecycle ? lifecycle.phase("patch", plan) : plan();
    if (rustDiagnosticMode) retainedPlanCount++;
    if (rustPhaseTimingMode) retainedPlanMs += performance.now() - planStarted;
    if (!patch) return false;
    if (visual.landingArms.length > 0 || (visual.hasOpenLanding() && !landingRidesPatch(patch) &&
      (patch.movedRoots > 0 || patch.hits.length > 0 || patch.nodeMatrices.length > 0)))
      return refuse("landing-requires-full-build");
    let landingCandidate = visual.captureLandingPresentation(next, at,
      landingRidesPatch(patch) ? landingCapturesFor(patch, snapshot) : snapshot.capturedGlobals, landingLiftsFor(patch, snapshot));
    if (next.changedIds.size === 0) {
      let committed: PresentationResult;
      let phaseSubmissionId: number | undefined;
      try {
        const submitted = submitRetainedPatch(patch, traceId);
        phaseSubmissionId = submitted.phaseSubmissionId;
        const result = submitted.result;
        if (isPromiseLike<PresentationResult>(result)) { trackAsyncRetainedPatch(result, patch, at, next, phaseSubmissionId, landingCandidate); return refuse("async-in-flight"); }
        if (!result.presented) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
          patchLost(patch, true); return refuse("presentation-refused"); }
        committed = result;
      } catch { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
        patchLost(patch, true); return refuse("presentation-error"); }
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
    // rustTextPatch: a label whose only change is its text is re-prepared below instead of moved.
    const textIds = fast.textPatch ? textOnlyChangedIds(next) : null;
    const spans: Array<{ start: number; end: number }> = [];
    // rustWireSpreadPatch: one scene-identity env and one ancestor re-walk cache per reconcile, shared by its spans.
    let spreadScene: ReturnType<typeof spreadSceneIdentityEnv> | undefined;
    let ancestorCache: Map<string, AncestorFrame | null> | undefined;
    let followersStale: boolean | undefined;
    // rustHeldOverridePatch: a streamed delta is the drawn delta only away from held overrides. On or under one the
    // node draws through the override's absolute pose; above one, the span would carry the overridden node along.
    const heldLineage = fast.heldOverridePatch && visual.transformOverrides.size
      ? overrideAncestors(visual.transformOverrides, next.nodes) : null;
    const spanLoopStarted = rustPhaseTimingMode ? performance.now() : 0;
    for (const id of next.changedIds) {
      if (textIds?.has(id)) continue;
      const before = snapshot.scene.nodes.get(id), after = next.nodes.get(id);
      if (!before || !after || before.parentId !== after.parentId || !before.transform || !after.transform) return refuse("wire-structure");
      // A volatile upsert rebuilds its colour objects, so the held-override lane compares small values by value.
      if (fast.heldOverridePatch) {
        if (!sameNodeExceptTransform(before, after)) return refuse("wire-nontransform-change");
        if (heldLineage && touchesOverrideLineage(id, visual.transformOverrides, heldLineage, next.nodes)) return refuse("wire-under-override");
      } else for (const key of Object.keys(before) as Array<keyof typeof before>)
        if (key !== "transform" && before[key] !== after[key]) return refuse("wire-nontransform-change");
      const gOld = global(snapshot.scene.nodes, id), gNew = global(next.nodes, id);
      const inverse = affineInverse(gOld);
      if (!inverse) return refuse("wire-noninvertible");
      const delta = affineMul(gNew, inverse);
      const span = snapshot.paintOrder.entries.get(id);
      if (!span || spans.some((other) => other.start < span.spanEnd && span.spanStart < other.end)) return refuse("wire-overlapping-span");
      spans.push({ start: span.spanStart, end: span.spanEnd });
      let sidecar = patchSidecars.get(patch);
      // rustOffsetPatch: an offset translation and a wire delta on one node would be two entries for one primitive.
      if (sidecar?.moved) for (let order = span.spanStart; order < span.spanEnd; order++)
        if (sidecar.moved.has(snapshot.paintOrder.ids[order])) return refuse("wire-offset-overlap");
      // A pure translation moves every captured pose in the span by the same vector, which the patch can recompute
      // (`rustOffsetPatch`); anything else would leave a captured global no patch can rebuild.
      const translation = fast.offsetPatch && isPureTranslation(delta);
      // The drawn picture must move by the streamed delta (see `translatedSpan`), which a view-scale stamp in or
      // above the span, a clip only a rebuild can move, or (widened stage) a field claim inside it, breaks: a claim
      // is measured at the node's own game X. Checked for every wire span, with or without the round's switches: a
      // wire patch of a claimer (a selection reticle, a targeting arrow) drew it at its stale spread shift, which
      // rustOffsetPatch exposed once offset frames stopped forcing builds.
      // rustWireSpreadPatch takes the spread part of the refusal over: it re-poses each node by its own drawn delta.
      const spreadAware = fast.wireSpreadPatch;
      {
        let blamed: string | undefined;
        const refusal = translatedSpanRefusal(id, delta, { build: snapshot.build, nodes: snapshot.scene.nodes,
          spreadFactor: spreadAware ? 1 : committedSpread.factor, fieldModes: committedSpread.claimers, shifted: committedSpread.shifted,
          clipsMovable: clipsMovable(), blame: (node) => { blamed = node; } });
        if (refusal) {
          offsetDeclines[refusal] = (offsetDeclines[refusal] ?? 0) + 1;
          if (refusal === "wire-spread") noteDeclineType(refusal, blamed === undefined ? undefined : snapshot.scene.nodes.get(blamed));
          return refuse(refusal);
        }
      }
      let spreadPlan: WireSpreadPlan | null = null;
      if (spreadAware) {
        const committedNodes = snapshot.scene.nodes, committedHits = snapshot.hitEntries;
        const declineSpread = (reason: string, node: string) => {
          offsetDeclines[reason] = (offsetDeclines[reason] ?? 0) + 1;
          wireSpreadDeclines[reason] = (wireSpreadDeclines[reason] ?? 0) + 1;
          noteDeclineType(reason, committedNodes.get(node));
          return refuse(reason);
        };
        // A stretch change since the committed build cleared the shifts this would read; the build it asked for redraws.
        if (committedSpread.factor !== visual.spreadFactor || (committedSpread.factor !== 1 && !committedSpread.dx))
          return declineSpread("wire-spread-factor", id);
        const input = snapshot.build.nodePaintInputs.get(id);
        const planned = planWireSpread({ rootId: id, before: snapshot.scene.nodes, after: next.nodes, order: snapshot.paintOrder,
          gOld, gNew, delta, drawnRoot: input ? retained.logicalNodeMatrix(id, input.global) : null,
          spreadFactor: committedSpread.factor, dx: committedSpread.dx ?? EMPTY_SPREAD, ownerReads: committedSpread.ownerReads,
          followerPoints: committedSpread.followerPoints, hitsOf: (node) => spanHits(committedHits, node),
          clipRanges: snapshot.build.clipRanges, sceneEnv: (spreadScene ??= spreadSceneIdentityEnv((node) => resolveSceneInfo(node, next.nodes))),
          ancestorCache: (ancestorCache ??= new Map()) });
        if ("reason" in planned) return declineSpread(planned.reason, planned.id);
        // A follower resolves against the hits PUBLISHED before its build; once a later patch changed what lies under
        // it, the next build moves it. Until that build, a span this switch re-poses would race it: refuse.
        if (planned.reposed && (followersStale ??= followerAnswersMoved(committedSpread.followerPoints)))
          return declineSpread("wire-spread-follower-stale", id);
        spreadPlan = planned;
        wireSpreadVisited += planned.visited;
        // A span this switch re-posed (or admitted where the plain patch refused) is shadow-checked under verify.
        if (planned.reposed) {
          if (!sidecar) { sidecar = {}; patchSidecars.set(patch, sidecar); }
          sidecar.spreadSpans = (sidecar.spreadSpans ?? 0) + 1;
          const moves = (sidecar.spread ??= new Map());
          for (const [node, dx] of planned.dx) moves.set(node, dx);
          if (fast.verify) sidecar.verify ??= captureHeldInputs();
        }
      }
      for (const [captured, entryValue] of snapshot.capturedGlobals) {
        const entry = snapshot.paintOrder.entries.get(captured);
        if (!entry || entry.order < span.spanStart || entry.order >= span.spanEnd) continue;
        if (!translation) return refuse("wire-captured-global");
        // A captured node moved along the field draws (and was rendered pre-offset) at its own shift: its drawn delta.
        const step = spreadPlan?.nodeDeltas?.get(captured) ?? delta;
        const tx = step[4], ty = delta[5];
        const shift = (m: Affine): Affine => [m[0], m[1], m[2], m[3], m[4] + tx, m[5] + ty];
        if (!sidecar) { sidecar = {}; patchSidecars.set(patch, sidecar); }
        sidecar.wireCaptured = true;
        // The changed root's parent is outside its span and did not move; every other parent moved with it.
        (sidecar.captures ??= new Map()).set(captured, { ...entryValue, g: shift(entryValue.g), drawn: shift(entryValue.drawn),
          parentTy: captured === id ? entryValue.parentTy : entryValue.parentTy + ty });
        if (fast.verify) sidecar.verify ??= captureHeldInputs();
      }
      // rustOffsetPatch: a clip rect is baked from its clipper's drawn box, so a span with a clipper moves only by a
      // translation the executor can apply to the clip as well.
      let moveClips = false;
      if (fast.offsetPatch) for (let order = span.spanStart; order < span.spanEnd; order++) {
        if (!snapshot.build.clipRanges.has(snapshot.paintOrder.ids[order])) continue;
        if (!translation || !clipsMovable()) return refuse("wire-clip");
        moveClips = true;
        break;
      }
      const part = retained.patchWireTransform(id, delta, spreadPlan ? { clips: moveClips, nodeDeltas: spreadPlan.nodeDeltas,
        uniformDrawn: spreadPlan.uniform, hitSpreadDx: spreadPlan.dx } : { clips: moveClips });
      if (!part) return refuse("wire-transform-unsupported");
      // A moving clipper whose clip did not come back would leave the clip behind its children.
      if (moveClips && (delta[4] !== 0 || delta[5] !== 0) && !part.clips?.length) return refuse("wire-clip");
      if (part.clips?.length) {
        (patch.clips ??= []).push(...part.clips);
        if (fast.verify) {
          sidecar = patchSidecars.get(patch);
          if (!sidecar) { sidecar = {}; patchSidecars.set(patch, sidecar); }
          sidecar.verify ??= captureHeldInputs();
        }
      }
      patch.primitives.push(...part.primitives);
      patch.hits.push(...part.hits);
      patch.nodeMatrices.push(...part.nodeMatrices);
      patch.movedRoots++;
    }
    if (rustPhaseTimingMode) wireSpanLoopMs += performance.now() - spanLoopStarted;
    if (textIds?.size) {
      const planned = planRendererTextPatch(next, textIds, patch, spans);
      if (typeof planned === "string") {
        textPatchDeclines[planned] = (textPatchDeclines[planned] ?? 0) + 1;
        return refuse(planned);
      }
      patch.texts = planned;
      const sidecar = patchSidecars.get(patch) ?? {};
      sidecar.textOwners = textIds;
      if (fast.verify) sidecar.textVerify = captureHeldInputs();
      patchSidecars.set(patch, sidecar);
    }
    // A landing row reads the hand holder's DRAWN pose after this frame, which a wire span that moved a captured
    // holder (`rustOffsetPatch`'s pure translation, or `rustWireSpreadPatch`'s re-pose) has just changed; the probe
    // taken above still holds the committed pose, and a row read off it stays open (every later moving patch then
    // rebuilds) until its timeout. Whichever patch moved the capture recomputed it exactly: probe the patched ones.
    const movedCaptures = patchSidecars.get(patch)?.captures;
    if (movedCaptures?.size && visual.hasOpenLanding())
      landingCandidate = visual.captureLandingPresentation(next, at, landingCapturesFor(patch, snapshot),
        landingLiftsFor(patch, snapshot));
    let committed: PresentationResult;
    let phaseSubmissionId: number | undefined;
    try {
      const submitted = submitRetainedPatch(patch, traceId);
      phaseSubmissionId = submitted.phaseSubmissionId;
      const result = submitted.result;
if (isPromiseLike<PresentationResult>(result)) { trackAsyncRetainedPatch(result, patch, at, next, phaseSubmissionId, landingCandidate); return refuse("async-in-flight"); }
      if (!result.presented) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
        patchLost(patch, true); return refuse("presentation-refused"); }
      committed = result;
    } catch { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
      patchLost(patch, true); return refuse("presentation-error"); }
    publishRetainedPatch(patch, at, next, committed, landingCandidate);
    if (rustExecutionPhaseMode) producerReasons!.finishRetainedIfOpen(phaseSubmissionId!, "committed");
    return true;
  }

  /** rustTextPatch: the changed ids whose only change is their label's text (`textOnlyChange`). */
  function textOnlyChangedIds(next: MirrorState): Set<string> {
    const ids = new Set<string>();
    if (!snapshot) return ids;
    for (const id of next.changedIds) {
      // A label the committed build drew no text for keeps its old decline (`wire-nontransform-change`).
      if (!textKeysByOwner.has(id)) continue;
      const before = snapshot.scene.nodes.get(id), after = next.nodes.get(id);
      if (before && after && textOnlyChange(before, after)) ids.add(id);
    }
    return ids;
  }
  /**
   * rustTextPatch: re-prepare each changed label from the committed build's paint record, exactly as that build's
   * `semanticText` would for the new text, or name why not (see `planTextPatch`). `movedSpans` are this frame's wire
   * spans.
   */
  function planRendererTextPatch(next: MirrorState, ids: ReadonlySet<string>, patch: RetainedPixiPatch,
    movedSpans: readonly { start: number; end: number }[]): PixiTextRecord[] | string {
    if (backend !== "rust" || textMode !== "native" || !retained || !snapshot || pixi?.patchesText !== true) return "text-unsupported";
    if (paintGeneration !== committedTextGeneration) return "text-build-moved";
    const composition = retained, drawn = snapshot;
    const lineage = visual.transformOverrides.size ? overrideAncestors(visual.transformOverrides, next.nodes) : null;
    let committedByKey: Map<string, PixiTextRecord> | undefined;
    return planTextPatch(ids, {
      keysOf: (id) => textKeysByOwner.get(id),
      committedText: (key) => (committedByKey ??= new Map(texts.map((text) => [text.key, text]))).get(key),
      built: (id) => textBuildInputs.has(id) && next.nodes.has(id),
      orderOf: (id) => drawn.paintOrder.entries.get(id)?.order,
      movedSpans,
      textPatchable: (id) => composition.textPatchable(id),
      underOverride: (id) => !!lineage && touchesOverrideLineage(id, visual.transformOverrides, lineage, next.nodes),
      sampled: new Set(patch.primitives.map((entry) => entry.id)),
      committedAlpha: (key) => retainedDiagnosticFields.get(`text:${key}`)?.alpha !== undefined,
      prepare: (id) => {
        const node = next.nodes.get(id)!, built = textBuildInputs.get(id)!;
        ensureNodeFonts(node);
        return prepareSemanticTextRecords({ node, nodes: next.nodes }, built.record, built.insertionIndex);
      },
    });
  }

  const IDENTITY_LINEAR = [1, 0, 0, 1] as const;
  const EMPTY_SPREAD: ReadonlyMap<string, number> = new Map();
  const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];
  /**
   * rustTweenRootPatch: an open landing row reads the hand holder's drawn pose off the captured globals, which a tween
   * re-pose recomputes exactly; it can ride the patch when nothing else in it moved a node (a local animation, an
   * offset translation). The landing probe is then taken from the patched captures.
   */
  const landingRidesPatch = (patch: RetainedPixiPatch) => patchSidecars.get(patch)?.landingPatchable === true;
  /**
   * The lifts the landing probe subtracts from a drawn pose: the offsets this patch draws when it translates them
   * (its patched captures already carry the new lift, as a full build's do), else the committed ones.
   */
  function landingLiftsFor(patch: RetainedPixiPatch, base: DrawnSceneSnapshot): ReadonlyMap<string, CosmeticOffset> {
    return patchSidecars.get(patch)?.frame?.cosmeticOffsets ?? interaction.cosmeticOffsetsFor(base);
  }
  function landingCapturesFor(patch: RetainedPixiPatch, base: DrawnSceneSnapshot): ReadonlyMap<string, CapturedGlobal> {
    const moved = patchSidecars.get(patch)?.captures;
    if (!moved?.size) return base.capturedGlobals;
    const captures = new Map(base.capturedGlobals);
    for (const [id, captured] of moved) captures.set(id, captured);
    return captures;
  }
  /** rustWireSpreadPatch: whether the current hits resolve any recorded remote follower to a different shift. */
  function followerAnswersMoved(points: readonly number[]): boolean {
    for (let i = 0; i < points.length; i += 3)
      if (visual.spreadRegistry.followerShift(points[i], points[i + 1]) !== points[i + 2]) return true;
    return false;
  }
  /** rustWireSpreadPatch: a hit list's entries by node, indexed on first use (only a follower check asks). */
  const hitsByNode = new WeakMap<readonly HitEntry[], Map<string, HitEntry[]>>();
  function spanHits(entries: readonly HitEntry[], id: string): readonly HitEntry[] | undefined {
    let index = hitsByNode.get(entries);
    if (!index) {
      index = new Map();
      for (const entry of entries) { const list = index.get(entry.nodeId); if (list) list.push(entry); else index.set(entry.nodeId, [entry]); }
      hitsByNode.set(entries, index);
    }
    return index.get(id);
  }
  /** rustOffsetPatch: the executor moves a clip rect by translation, so a translated clipper can be patched. */
  const clipsMovable = () => fast.offsetPatch && backend === "rust" && pixi?.translatesClips === true;
  /** Each build's clippers' hit clip scopes, by clipper id (one scope object, shared by the hits under it). */
  const hitClipScopes = new WeakMap<readonly HitEntry[], Map<string, ClipScope>>();
  /** Move the hit clip scopes of the clips a committed patch translated: a tap clips against the drawn rect. */
  function translateHitClips(entries: readonly HitEntry[], clips: readonly ClipTranslation[]): void {
    let scopes = hitClipScopes.get(entries);
    if (!scopes) {
      scopes = new Map();
      for (const entry of entries) for (const scope of entry.clipScopeChain) scopes.set(scope.id, scope);
      hitClipScopes.set(entries, scopes);
    }
    for (const { id, dx, dy } of clips) {
      const scope = scopes.get(id);
      // Replaced, never edited in place.
      if (scope) scope.spec = { ...scope.spec, x: scope.spec.x + dx, y: scope.spec.y + dy };
    }
  }
  function planRetainedSample(next: MirrorState): RetainedPixiPatch | null {
    const refuse = (reason: string) => { retainedDecline = reason; return null; };
    if (!retainedMode || !retainedValid || !snapshot || !retained || !pixi || readiness !== "ready") {
      retainedDecline = "invalid-retained-state"; return null;
    }
    // rustHeldOverridePatch admits overrides held unchanged since the committed build: the same keys, bitwise.
    // rustTweenRootPatch (on top of it) also admits the same keys at new values: each moved override root's span is
    // re-posed below (`planTweenRoots`).
    const tweenOn = fast.tweenRootPatch && fast.heldOverridePatch;
    let tweenRoots: string[] | null = null;
    if (fast.heldOverridePatch) {
      if (!committedOverrides) return refuse("transform-overrides");
      if (!sameTransformOverrides(visual.transformOverrides, committedOverrides)) {
        if (!tweenOn) return refuse("transform-overrides");
        tweenRoots = movedOverrideRoots(visual.transformOverrides, committedOverrides);
        // A new or dropped override is not a tween root moving: the build it needs is the held lane's.
        if (!tweenRoots) { declineTween("tween-root-keys", undefined); return refuse("transform-overrides"); }
      }
    } else if (visual.transformOverrides.size) { retainedDecline = "transform-overrides"; return null; }
    // A transform sample is a tween root's (patched below, or unchanged since the committed build).
    if ((visual.frameSampleMask & ~(SAMPLE_LOCAL_ANIM | SAMPLE_OPACITY | SAMPLE_SELF_OPACITY | SAMPLE_SOURCE |
      (tweenOn ? SAMPLE_TRANSFORM : 0))) !== 0) {
      retainedDecline = "unsupported-sample"; return null;
    }
    const held = fast.heldOverridePatch && visual.transformOverrides.size > 0;
    // An overridden node draws at its absolute pose whatever its ancestors do, so a local animation above it must
    // not carry it along. The build's frames never include a root that carries an override itself.
    if (held) {
      const ancestors = overrideAncestors(visual.transformOverrides, snapshot.scene.nodes);
      for (const root of snapshot.build.localAnimFrames.keys()) if (ancestors.has(root)) return refuse("anim-over-override");
    }
    let offsetPlan: OffsetTranslation | null = null;
    const offsetsMoved = !interaction.cosmeticOffsetsMatch(snapshot);
    if (interaction.offsetPending || offsetsMoved) {
      if (!fast.offsetPatch) { retainedDecline = "offset-pending"; return null; }
    }
    if (offsetsMoved) {
      const planned = planOffsetTranslation(snapshot);
      if (typeof planned === "string") { offsetDeclines[planned] = (offsetDeclines[planned] ?? 0) + 1; return refuse(planned); }
      offsetPlan = planned;
    }
    const sourceMark = visual.sampleMark();
    const patch = retained.patch(visual.localAnims, offsetPlan?.rootShifts);
    if (!patch) { retainedDecline = "composition-refused"; return null; }
    patchSourceMarks.set(patch, sourceMark);
    const animMovedRoots = patch.movedRoots;
    // rustTweenRootPatch first: a tween span that this frame's offsets move uniformly takes their translation into its
    // own deltas, and leaves the offset plan with the rest.
    const tweenSpans: Array<{ start: number; end: number }> = [];
    if (tweenRoots?.length) {
      const refusal = planTweenRoots(snapshot, patch, tweenRoots, offsetPlan, tweenSpans);
      if (refusal) return refuse(refusal);
    } else if (held) heldPatches.set(patch, fast.verify ? captureHeldInputs() : null);
    if (offsetPlan) {
      const part = retained.patchTranslate(offsetPlan.deltas, { clips: clipsMovable() });
      if (!part) { offsetDeclines["offset-anim-span"] = (offsetDeclines["offset-anim-span"] ?? 0) + 1; return refuse("offset-anim-span"); }
      if (part.clips?.length) (patch.clips ??= []).push(...part.clips);
      patch.primitives.push(...part.primitives);
      patch.hits.push(...part.hits);
      patch.nodeMatrices.push(...part.nodeMatrices);
      const sidecar = patchSidecars.get(patch);
      // The tween planner's captures are the span's (it folded the offsets in): they win over the offset plan's.
      const captures = new Map(offsetPlan.captures);
      for (const [id, captured] of sidecar?.captures ?? []) captures.set(id, captured);
      patchSidecars.set(patch, { ...sidecar, frame: offsetPlan.frame, captures, moved: offsetPlan.moved,
        verify: sidecar?.verify ?? (fast.verify ? captureHeldInputs() : undefined) });
    }
    // rustTweenRootPatch: whether an open landing may ride this patch.
    if ((tweenRoots?.length || offsetPlan) && fast.tweenRootPatch && fast.heldOverridePatch && visual.hasOpenLanding()) {
      const safe = landingRidesSafely(snapshot, tweenSpans, offsetPlan, animMovedRoots);
      if (!safe && offsetPlan) { offsetDeclines["offset-landing"] = (offsetDeclines["offset-landing"] ?? 0) + 1; return refuse("offset-landing"); }
      const sidecar = patchSidecars.get(patch) ?? {};
      sidecar.landingPatchable = safe;
      patchSidecars.set(patch, sidecar);
    }
    const byId = new Map(patch.primitives.map((entry) => [entry.id, entry]));
    const update = (id: string) => {
      let entry = byId.get(id);
      if (!entry) { entry = { id }; patch.primitives.push(entry); byId.set(id, entry); }
      return entry;
    };
    const base = snapshot;
    const quad = createQuadView(), nine = createNinePatchView(), mesh = createTexturedMeshView();
    if (visual.opacityPatchIds.size) {
      const touched = new Set<string>();
      for (const root of visual.opacityPatchIds) {
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

  /** rustTweenRootPatch: one refusal, counted and attributed to the node it tripped on. */
  function declineTween(reason: string, id: string | undefined): string {
    tweenDeclines[reason] = (tweenDeclines[reason] ?? 0) + 1;
    noteDeclineType(reason, id === undefined ? undefined : snapshot?.scene.nodes.get(id));
    return reason;
  }

  /** The override roots whose sample moved since the committed bank, or null when the key sets differ. */
  function movedOverrideRoots(current: ReadonlyMap<string, readonly number[]>, committed: ReadonlyMap<string, readonly number[]>): string[] | null {
    if (current.size !== committed.size) return null;
    const moved: string[] = [];
    for (const [id, matrix] of current) {
      const banked = committed.get(id);
      if (!banked || banked.length !== matrix.length) return null;
      for (let i = 0; i < matrix.length; i++) if (!Object.is(matrix[i], banked[i])) { moved.push(id); break; }
    }
    return moved;
  }

  /** A node's streamed (game) global, composed root-first as the walk composes `gGame`. */
  function streamedGameGlobal(nodes: ReadonlyMap<string, MirrorNode>, id: string): Affine {
    const chain: MirrorNode[] = [];
    for (let node = nodes.get(id); node; node = node.parentId ? nodes.get(node.parentId) : undefined) chain.push(node);
    let pose: Affine = [1, 0, 0, 1, 0, 0];
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].transform) pose = affineMul(pose, chain[i].transform as Affine);
    return pose;
  }

  /**
   * rustTweenRootPatch: re-pose the span of every override root whose sample moved (a hand holder's pick-up or release
   * tween) and append it to `patch`, or say why it must build.
   *
   * An override is the root's ABSOLUTE rendered global (`gRaw`); its descendants compose through it, and the build
   * re-bases every field claim in the span at the rendered pose. So the span's rendered globals move by
   * `Δ = O_new·O_old⁻¹` while its game globals stay, and each node is re-posed by `T(O + s'ᵢ)·Δ·T(−O − sᵢ)` with `s'ᵢ`
   * from the R2-C re-walk (`planWireSpread` with `rendered`). Hits keep `mGame`. Text needs no refusal: the Rust text
   * path rasters at the style's size, keyed without the transform (`createRustDrawListExecutor.textResourceKey`), so
   * a scaled record draws what a rebuild draws. Refused: a clip or polyline in the span (`Δ` scales), a view-scale
   * stamp or candidate in or above it, a nested override, a local animation or source sample in it, a card trail, an
   * overlap with this frame's offset translation, and everything `planWireSpread` refuses.
   */
  function planTweenRoots(base: DrawnSceneSnapshot, patch: RetainedPixiPatch, roots: readonly string[],
    offsetPlan: OffsetTranslation | null, spans: Array<{ start: number; end: number }>): string | null {
    const build = base.build, nodes = base.scene.nodes, current = visual.transformOverrides, committed = committedOverrides!;
    if (committedSpread.factor !== visual.spreadFactor || (committedSpread.factor !== 1 && !committedSpread.dx))
      return declineTween("tween-root-factor", roots[0]);
    const sidecar = patchSidecars.get(patch) ?? {};
    const sceneEnv = spreadSceneIdentityEnv((node) => resolveSceneInfo(node, nodes));
    const ancestorCache = new Map<string, AncestorFrame | null>();
    let followersStale: boolean | undefined;
    const planned = new Map<string, readonly number[]>();
    const moves = new Map<string, number>();
    let patchedRoots = 0;
    for (const id of roots) {
      const span = build.order.entries.get(id), input = build.nodePaintInputs.get(id);
      // A root the committed build never walked drew nothing to move.
      if (!span || !input) continue;
      if (spans.some((other) => other.start < span.spanEnd && span.spanStart < other.end)) return declineTween("tween-root-nested", id);
      spans.push({ start: span.spanStart, end: span.spanEnd });
      for (let order = span.spanStart; order < span.spanEnd; order++) {
        const node = build.order.ids[order], wire = nodes.get(node);
        if (node !== id && current.has(node)) return declineTween("tween-root-nested", node);
        if (visual.localAnims.has(node) || build.localAnimFrames.has(node)) return declineTween("tween-root-anim", node);
        if (visual.sourceSampledIds.has(node)) return declineTween("tween-root-source", node);
        if (wire && (isCardTrailNode(wire) || isCardTrailRootNode(wire))) return declineTween("tween-root-trail", node);
        const range = build.ranges.get(node);
        if (range) for (let index = range.start; index < range.paintEnd; index++)
          if (list.kindNameAt(index) === "polyline") return declineTween("tween-root-polyline", node);
      }
      for (const root of build.localAnimFrames.keys()) {
        const other = build.order.entries.get(root);
        if (other && other.spanStart < span.spanEnd && span.spanStart < other.spanEnd) return declineTween("tween-root-anim", root);
      }
      // This frame's offsets over the span: one translation `d` for every node (an owner at or above the root
      // moved) folds into each drawn delta, `T(d)·Dᵢ`; an owner inside the span moving on its own does not.
      let shift: readonly [number, number] | null = null;
      if (offsetPlan) for (let order = span.spanStart; order < span.spanEnd; order++) {
        const node = build.order.ids[order], own = offsetPlan.deltas.get(node) ?? null;
        if (order === span.spanStart) { shift = own; continue; }
        if ((own === null) !== (shift === null) || (own && shift && (own[0] !== shift[0] || own[1] !== shift[1])))
          return declineTween("tween-root-offset-overlap", node);
      }
      const old = committed.get(id) as Affine, now = [...current.get(id)!] as Affine;
      const inverse = affineInverse(old);
      if (!inverse) return declineTween("tween-root-noninvertible", id);
      const delta = affineMul(now, inverse);
      {
        let blamed: string | undefined;
        const refusal = translatedSpanRefusal(id, delta, { build, nodes, spreadFactor: 1, fieldModes: committedSpread.claimers,
          shifted: committedSpread.shifted, clipsMovable: false, blame: (node) => { blamed = node; } });
        if (refusal) return declineTween(refusal.replace(/^wire-/, "tween-root-"), blamed ?? id);
      }
      const g = streamedGameGlobal(nodes, id);
      const plan = planWireSpread({ rootId: id, before: nodes, after: nodes, order: build.order, gOld: g, gNew: g, delta,
        rendered: { old, now }, gameDelta: IDENTITY_AFFINE, tag: "tween-root",
        drawnRoot: retained!.logicalNodeMatrix(id, input.global), spreadFactor: committedSpread.factor,
        dx: committedSpread.dx ?? EMPTY_SPREAD, ownerReads: committedSpread.ownerReads, followerPoints: committedSpread.followerPoints,
        hitsOf: (node) => spanHits(base.hitEntries, node),
        clipRanges: build.clipRanges, sceneEnv, ancestorCache });
      if ("reason" in plan) return declineTween(plan.reason, plan.id);
      if (plan.dx.size && (followersStale ??= followerAnswersMoved(committedSpread.followerPoints)))
        return declineTween("tween-root-follower-stale", id);
      const shifted = (m: Affine): Affine => shift ? [m[0], m[1], m[2], m[3], m[4] + shift[0], m[5] + shift[1]] : m;
      const nodeDeltas = plan.nodeDeltas && shift ? new Map([...plan.nodeDeltas].map(([node, m]) => [node, shifted(m)])) : plan.nodeDeltas;
      const uniform = shifted(plan.uniform);
      const part = retained!.patchWireTransform(id, IDENTITY_AFFINE, { nodeDeltas, uniformDrawn: uniform, hitSpreadDx: plan.dx });
      if (!part) return declineTween("tween-root-anim-span", id);
      // Captured globals in the span: `g` is the pre-offset rendered pose `T(s)·gRaw`, `drawn` the drawn one, and
      // `parentTy` the parent's drawn Y (the root's parent did not move).
      const deltaOf = (node: string) => nodeDeltas?.get(node) ?? uniform;
      for (const [captured, value] of base.capturedGlobals) {
        const entry = build.order.entries.get(captured);
        if (!entry || entry.order < span.spanStart || entry.order >= span.spanEnd) continue;
        const s = committedSpread.factor === 1 ? 0 : committedSpread.dx?.get(captured) ?? 0, s2 = plan.dx.get(captured) ?? s;
        const g2 = affineMul([1, 0, 0, 1, s2, 0], affineMul(delta, affineMul([1, 0, 0, 1, -s, 0], value.g)));
        const parent = nodes.get(captured)?.parentId;
        // The root's parent is outside the span: only this frame's offsets can move its drawn Y.
        let parentTy = value.parentTy + (parent == null ? 0 : offsetPlan?.deltas.get(parent)?.[1] ?? 0);
        if (captured !== id && parent != null) {
          const parentInput = build.nodePaintInputs.get(parent);
          if (!parentInput) return declineTween("tween-root-capture", captured);
          const m = retained!.logicalNodeMatrix(parent, parentInput.global), d = deltaOf(parent);
          parentTy = d[1] * m[4] + d[3] * m[5] + d[5];
        }
        (sidecar.captures ??= new Map()).set(captured, { ...value, g: g2, drawn: affineMul(deltaOf(captured), value.drawn), parentTy });
      }
      for (const [node, dx] of plan.dx) moves.set(node, dx);
      // The span's offset translation is in its deltas now: the offset plan must not move it again.
      if (shift) for (let order = span.spanStart; order < span.spanEnd; order++) offsetPlan!.deltas.delete(build.order.ids[order]);
      patch.primitives.push(...part.primitives);
      patch.hits.push(...part.hits);
      patch.nodeMatrices.push(...part.nodeMatrices);
      patch.movedRoots++;
      patchedRoots++;
      tweenRootVisited += plan.visited;
      planned.set(id, now);
    }
    // Every override, moved or not, by value: the bank the next frame's deltas are measured against.
    const bank = new Map<string, readonly number[]>();
    for (const [id, matrix] of current) bank.set(id, planned.get(id) ?? [...matrix]);
    if (moves.size) { const spread = (sidecar.spread ??= new Map()); for (const [node, dx] of moves) spread.set(node, dx); }
    sidecar.tween = { overrides: bank, roots: patchedRoots };
    if (fast.verify) sidecar.verify ??= captureHeldInputs();
    patchSidecars.set(patch, sidecar);
    return null;
  }

  /**
   * rustTweenRootPatch: whether every open landing node this patch moves has its captured pose recomputed, so the
   * landing probe can read the patched captures: a node in a tween span (re-posed above) or one this frame's offsets
   * moved (the offset plan recomputes every captured node it moves; landing nodes are captured). A node a moving
   * local animation carries is not.
   */
  function landingRidesSafely(base: DrawnSceneSnapshot, tweenSpans: ReadonlyArray<{ start: number; end: number }>,
    offsetPlan: OffsetTranslation | null, animMovedRoots: number): boolean {
    const build = base.build, landingIds = new Set<string>();
    visual.collectLandingCaptureIds(landingIds);
    for (const id of landingIds) {
      const entry = build.order.entries.get(id);
      if (!entry || tweenSpans.some((span) => entry.order >= span.start && entry.order < span.end)) continue;
      if (offsetPlan?.deltas.has(id) && !offsetPlan.captures.has(id)) return false;
      if (animMovedRoots > 0) for (const root of build.localAnimFrames.keys()) {
        const span = build.order.entries.get(root);
        if (span && entry.order >= span.spanStart && entry.order < span.spanEnd) return false;
      }
    }
    return true;
  }

  type OffsetTranslation = { deltas: Map<string, [number, number]>; captures: Map<string, CapturedGlobal>; frame: OffsetPatchFrame;
    /** Outermost local-animation roots whose whole span moves by one translation, which the root's frame carries. */
    rootShifts: Map<string, readonly [number, number]>;
    /** Every node the patch moves, root spans included. */
    moved: ReadonlySet<string> };

  /**
   * rustOffsetPatch: the design-space translation every drawn node owes the cosmetic offsets that changed since the
   * committed build, or the reason a translation cannot express them.
   *
   * The walk adds an owner's offset to its drawn origin as `parentFinal.linear · offset · kIn`, and every
   * descendant inherits it as a plain translation (`buildDrawList.ts`, COSMETIC OFFSET). Offsets never touch a
   * linear part, so the parent's committed drawn linear IS the walk's `parentFinal` linear wherever no view-scale
   * stamp sits above the owner (then `kIn` is 1); a stamped or candidate ancestor is refused. What a translation
   * cannot carry is refused too: a clip rect (built from the drawn pose), a view-scale candidate in the moved set
   * (its stamp is measured where it is drawn), a local-animation root (posed against its own reference), an open
   * landing, and an offset owner the committed build did not capture.
   */
  function planOffsetTranslation(base: DrawnSceneSnapshot): OffsetTranslation | string {
    const committed = interaction.cosmeticOffsetsFor(base), current = interaction.cosmeticOffsets;
    const build = base.build, nodes = base.scene.nodes;
    // rustTweenRootPatch: an open landing is checked once the whole patch is planned (`landingRidesSafely`).
    if (visual.landingArms.length > 0 || (visual.hasOpenLanding() && !(fast.tweenRootPatch && fast.heldOverridePatch)))
      return "offset-landing";
    const deltas = new Map<string, [number, number]>();
    const owners = new Set<string>([...committed.keys(), ...current.keys()]);
    for (const id of owners) {
      const was = committed.get(id), now = current.get(id);
      const ddx = (now?.dx ?? 0) - (was?.dx ?? 0), ddy = (now?.dy ?? 0) - (was?.dy ?? 0);
      if (ddx === 0 && ddy === 0) continue;
      // A node the committed build never walked draws nothing an offset could move.
      if (!build.nodePaintInputs.has(id)) continue;
      const node = nodes.get(id), span = build.order.entries.get(id);
      if (!node || !span) return "offset-missing-span";
      if (now && !base.capturedGlobals.has(id)) return "offset-uncaptured";
      let linear: ArrayLike<number> = IDENTITY_LINEAR;
      if (node.parentId != null) {
        const parent = build.nodePaintInputs.get(node.parentId);
        if (!parent) return "offset-missing-parent";
        linear = parent.global;
      }
      for (let up: string | null | undefined = node.parentId; up != null; up = nodes.get(up)?.parentId)
        if (build.viewScaleCandidates.has(up) || build.viewScaleStamps.has(up)) return "offset-view-scale";
      const dx = linear[0] * ddx + linear[2] * ddy, dy = linear[1] * ddx + linear[3] * ddy;
      for (let order = span.spanStart; order < span.spanEnd; order++) {
        const moved = build.order.ids[order], prior = deltas.get(moved);
        if (prior) { prior[0] += dx; prior[1] += dy; } else deltas.set(moved, [dx, dy]);
      }
    }
    for (const id of deltas.keys()) {
      if (build.clipRanges.has(id) && !clipsMovable()) { noteDeclineType("offset-clip", nodes.get(id)); return "offset-clip"; }
      if (build.viewScaleCandidates.has(id) || build.viewScaleStamps.has(id)) { noteDeclineType("offset-view-scale", nodes.get(id)); return "offset-view-scale"; }
    }
    // A moved local-animation root: its frame's `outer` carries the inherited cosmetic offset, so a span that moves
    // as one translation re-poses as `T · outer · raw` (`retainedComposition.patch`). Only the outermost root of the
    // span is shifted: a nested root's delta is composed under its outer root's, which already carries `T`. The
    // span must move uniformly (no offset owner inside it), and hold no captured global (an animated node's
    // captured pose is the admission phase, which no patch re-poses) and no clipper.
    const moved = new Set(deltas.keys());
    const rootShifts = new Map<string, readonly [number, number]>();
    for (const root of build.localAnimFrames.keys()) {
      const shift = deltas.get(root);
      if (!shift) continue;
      const span = build.order.entries.get(root)!;
      let outermost = true;
      for (const other of build.localAnimFrames.keys()) {
        const enclosing = other === root ? undefined : build.order.entries.get(other);
        if (enclosing && enclosing.spanStart <= span.spanStart && span.spanEnd <= enclosing.spanEnd) { outermost = false; break; }
      }
      if (!outermost) continue;
      for (let order = span.spanStart; order < span.spanEnd; order++) {
        const id = build.order.ids[order], own = deltas.get(id);
        if (!own || own[0] !== shift[0] || own[1] !== shift[1]) { noteDeclineType("offset-anim", nodes.get(root)); return "offset-anim"; }
        if (base.capturedGlobals.has(id)) { noteDeclineType("offset-anim-captured", nodes.get(id)); return "offset-anim-captured"; }
        // The root's frame moves its commands and hits, not a clip rect or a hit clip scope.
        if (build.clipRanges.has(id)) { noteDeclineType("offset-anim-clip", nodes.get(id)); return "offset-anim-clip"; }
      }
      rootShifts.set(root, [shift[0], shift[1]]);
    }
    for (const [root] of rootShifts) {
      const span = build.order.entries.get(root)!;
      for (let order = span.spanStart; order < span.spanEnd; order++) deltas.delete(build.order.ids[order]);
    }
    // A root still in `deltas` sits inside an unshifted root's span (moved by an owner between them): refused.
    for (const id of deltas.keys())
      if (build.localAnimFrames.has(id)) { noteDeclineType("offset-anim", nodes.get(id)); return "offset-anim"; }
    const captures = new Map<string, CapturedGlobal>();
    for (const [id, captured] of base.capturedGlobals) {
      const own = deltas.get(id), parentId = nodes.get(id)?.parentId, ofParent = parentId == null ? undefined : deltas.get(parentId);
      if (!own && !ofParent) continue;
      const drawn = own ? [captured.drawn[0], captured.drawn[1], captured.drawn[2], captured.drawn[3],
        captured.drawn[4] + own[0], captured.drawn[5] + own[1]] as Affine : captured.drawn;
      captures.set(id, { ...captured, drawn, parentTy: captured.parentTy + (ofParent?.[1] ?? 0) });
    }
    return { deltas, captures, frame: interaction.captureOffsetFrame(), rootShifts, moved };
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
  const poseText = (m: ArrayLike<number> | undefined) => m ? `[${Array.from(m, (v) => +v.toFixed(3)).join(",")}]` : "none";
  /**
   * `compareCaptures` is the offset family's verify (captured globals move too). `moved` is the set the patch
   * translated (empty for a held-override patch); given, a mismatching command's note carries both poses and what
   * drove the owner.
   */
  function verifyHeldOverridePatch(inputs: HeldPatchInputs, stats: VerifyStats, compareCaptures = false,
    moved?: ReadonlySet<string>, spreadMoves?: ReadonlyMap<string, number>, textContent?: ReadonlySet<string>): void {
    const current = state, drawn = snapshot, composition = retained;
    if (!current || !drawn || !composition) return;
    stats.runs++;
    const shadowCaptures = new Map<string, CapturedGlobal>();
    const shadow = createDrawList<string>();
    const skipRoots = new Set<string>();
    if (staticBackground) for (const node of current.nodes.values())
      if (staticBgTargetPathOf(node, current.nodes) !== null && isStaticBackgroundSuppressibleRoot(node, current.nodes)) skipRoots.add(node.id);
    const refill = <K, V>(map: Map<K, V>, entries: ReadonlyArray<[K, V]>) => { map.clear(); for (const [k, v] of entries) map.set(k, v); };
    const liveTexts = texts.slice(), liveOwners = [...textOwners], liveKeys = [...textKeysByOwner], liveFailures = [...semanticFailures];
    const liveTextInputs = [...textBuildInputs];
    const liveDx = [...spreadDxByNode], liveModes = [...spreadFieldModeByNode], liveLayouts = nativeLayouts;
    texts.length = 0; textOwners.clear(); textKeysByOwner.clear(); textBuildInputs.clear(); semanticFailures.clear(); spreadDxByNode.clear(); spreadFieldModeByNode.clear();
    let reference: DrawListBuild | null = null, referenceTexts: PixiTextRecord[] = [], refused: string | null = null;
    let shadowSpread: Map<string, number> | null = null;
    try {
      reference = buildDrawList(current, shadow, { scratch: createPaintScratch(), skipRoots,
        skipHiddenHitCandidates: rustSkipHiddenHitCandidates, handRaiseChrome: handRaiseChrome ? handRaiseChromePainter : null,
        textureSize: (url) => pixi?.textureSize(url) ?? null, spreadFactor: visual.spreadFactor,
        spreadRegistry: visual.spreadRegistry, spreadDxOut: spreadDxByNode, spreadFieldModeOut: spreadFieldModeByNode,
        transformOverrides: inputs.overrides.size ? inputs.overrides : null, alphaOverrides: inputs.alphas.size ? inputs.alphas : null,
        localAnims: inputs.anims.size ? inputs.anims : null, frameSubstitutes: inputs.substitutes.size ? inputs.substitutes : null,
        viewScaleEnv: visual.viewScaleEnv, tipScaleEnv: visual.tipScaleEnv, pinnedLocals: visual.pinnedLocals,
        cosmeticOffsets: inputs.offsets, semanticText,
        captureGlobals: compareCaptures ? { ids: new Set(drawn.capturedGlobals.keys()), out: shadowCaptures } : null,
        semanticOverlay: (input, record, index) => semanticOverlay(input, record, index, shadow),
        forceEffectStillOverlay, assert: false });
      if (semanticFailures.size !== liveFailures.length ||
          [...semanticFailures].some(([id, reason]) => liveFailures.find(([liveId]) => liveId === id)?.[1] !== reason))
        refused = "semantic omissions changed during shadow build";
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    } finally {
      // rustWireSpreadPatch: the shifts the shadow walk banked, against the committed (patched) bank below.
      if (spreadMoves) shadowSpread = new Map(spreadDxByNode);
      referenceTexts = texts.slice();
      texts.length = 0; for (const text of liveTexts) texts.push(text);
      refill(textOwners, liveOwners); refill(textKeysByOwner, liveKeys); refill(semanticFailures, liveFailures);
      refill(textBuildInputs, liveTextInputs);
      refill(spreadDxByNode, liveDx); refill(spreadFieldModeByNode, liveModes); nativeLayouts = liveLayouts;
    }
    let mismatches = 0;
    const notes: string[] = [];
    const note = (detail: string) => {
      mismatches++; stats.firstMismatch ??= detail; if (notes.length < 32) notes.push(detail);
      const kind = verifyNoteKind(detail);
      stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;
    };
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
        if (!(error <= stats.maxError)) stats.maxError = Number.isNaN(error) ? Infinity : error;
      }
      return within;
    };
    if (refused !== null || !reference) note(`shadow build: ${refused}`);
    else {
      const quad = createQuadView(), nine = createNinePatchView(), mesh = createTexturedMeshView();
      const clip = createClipRectView(), liveClip = createClipRectView(), line = createPolylineView(), liveLine = createPolylineView();
      const liveQuad = createQuadView();
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
            let m: ArrayLike<number> = kind === "quad" ? shadow.readQuad(index, quad).m
              : kind === "ninePatch" ? shadow.readNinePatch(index, nine).m : shadow.readTexturedMesh(index, mesh).m;
            let drawnMatrix: ArrayLike<number> | undefined = composition.logicalMatrix(key);
            if (kind === "quad" && drawnMatrix) {
              // A source patch re-expresses a new atlas frame in the admitted quad's box (a scaled matrix), where a
              // rebuild draws the frame at its own size. Compare what is placed: the matrix times its box.
              const live = list.readQuad(liveIndex, liveQuad);
              const placed = (pose: ArrayLike<number>, w: number, h: number) =>
                [pose[0] * w, pose[1] * w, pose[2] * h, pose[3] * h, pose[4], pose[5]];
              drawnMatrix = placed(drawnMatrix, live.w, live.h);
              m = placed(m, quad.w, quad.h);
            }
            if (!matches(m, drawnMatrix)) note(moved ? `${key} drawn=${poseText(drawnMatrix)} rebuilt=${poseText(m)}` +
              `${moved.has(owner) ? " moved" : ""}${visual.sourceSampledIds.has(owner) ? " source" : ""}` +
              `${visual.localAnims.has(owner) || drawn.build.localAnimFrames.has(owner) ? " anim" : ""}` : key);
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
            // A clip rect moves only by a committed translation (`rustOffsetPatch`).
            const rebuilt = shadow.readClipRect(index, clip), committed = list.readClipRect(liveIndex, liveClip);
            const [dx, dy] = composition.clipOffset(liveIndex);
            if (!matches([rebuilt.x, rebuilt.y, rebuilt.w, rebuilt.h], [committed.x + dx, committed.y + dy, committed.w, committed.h], 4)) note(key);
          }
        }
      }
      const drawnTexts = new Set(texts.map((record) => record.key)), rebuiltTexts = new Set(referenceTexts.map((record) => record.key));
      for (const record of texts) if (!rebuiltTexts.has(record.key))
        note(`text drawn, not rebuilt: ${record.key} alpha ${record.alpha ?? 1}->${retainedDiagnosticFields.get(`text:${record.key}`)?.alpha ?? "unpatched"} ${ownerState(textOwners.get(record.key))}`);
      for (const record of referenceTexts) {
        if (!drawnTexts.has(record.key)) note(`text rebuilt, not drawn: ${record.key} alpha ${record.alpha ?? 1} ${ownerState(record.labelId)}`);
        else if (!matches(record.transform, composition.logicalMatrix(`text:${record.key}`))) note(`text:${record.key}`);
        else if (textContent?.has(record.labelId ?? "")) {
          // rustTextPatch: a re-prepared label must be the record a rebuild prepares, not just placed like one.
          const drawnRecord = texts.find((entry) => entry.key === record.key);
          // Every field the executor's resource key or command reads: rich runs, both revision keys, style, tint.
          const content = (entry: PixiTextRecord | undefined) => {
            const extra = entry as (PixiTextRecord & Record<string, unknown>) | undefined;
            return entry && JSON.stringify([entry.text, entry.style, entry.alpha, entry.tint, entry.blend,
              entry.resourceRevision, extra?.contentKey, extra?.runs, extra?.localTransform, entry.insertionIndex,
              extra?.labelId, extra?.msdf, extra?.inlineImage]);
          };
          if (!drawnRecord || content(drawnRecord) !== content(record) || !matches(record.transform, drawnRecord.transform))
            note(`text-content:${record.key} drawn=${JSON.stringify(drawnRecord?.text)} rebuilt=${JSON.stringify(record.text)}`);
        }
      }
      // rustTextPatch: the committed Rust command (and its resource) of each re-prepared label must be the one the
      // executor emits for the rebuilt record, so a stale rich run or font revision cannot hide behind a matching
      // record transform.
      if (textContent?.size && typeof pixi?.verifyTextCommands === "function")
        for (const detail of pixi.verifyTextCommands(referenceTexts.filter((record) => textContent.has(record.labelId ?? ""))))
          note(`text-command:${detail}`);
      // Every clip rect, wherever its push sits: the drawn one (as admitted plus any committed translation) must be
      // the rebuilt one.
      for (const [owner, range] of reference.clipRanges) {
        const committedRange = drawn.build.clipRanges.get(owner);
        if (!committedRange) { note(`clip rebuilt, not drawn: ${owner}`); continue; }
        const rebuilt = shadow.readClipRect(range.push, clip), committed = list.readClipRect(committedRange.push, liveClip);
        const [dx, dy] = composition.clipOffset(committedRange.push);
        if (!matches([rebuilt.x, rebuilt.y, rebuilt.w, rebuilt.h], [committed.x + dx, committed.y + dy, committed.w, committed.h], 4))
          note(`clip:${owner}`);
      }
      for (const owner of drawn.build.clipRanges.keys()) if (!reference.clipRanges.has(owner)) note(`clip drawn, not rebuilt: ${owner}`);
      const sameChain = (a: readonly ClipScope[], b: readonly ClipScope[]) => a.length === b.length && a.every((scope, i) =>
        scope.id === b[i].id && matches([scope.spec.x, scope.spec.y, scope.spec.w, scope.spec.h],
          [b[i].spec.x, b[i].spec.y, b[i].spec.w, b[i].spec.h], 4));
      if (reference.hitEntries.length !== drawn.hitEntries.length)
        note(`hit entries: ${drawn.hitEntries.length} drawn, ${reference.hitEntries.length} rebuilt`);
      else for (let i = 0; i < drawn.hitEntries.length; i++) {
        const rebuilt = reference.hitEntries[i], committed = drawn.hitEntries[i];
        if (rebuilt.nodeId !== committed.nodeId || !matches(rebuilt.mFinal, committed.mFinal) ||
          !matches(rebuilt.mGame, committed.mGame)) note(`hit:${committed.nodeId}${rebuilt.nodeId !== committed.nodeId ? ` vs ${rebuilt.nodeId}` : ""}`);
        else if (!sameChain(rebuilt.clipScopeChain, committed.clipScopeChain)) note(`hit-clip:${committed.nodeId}`);
        else if (spreadMoves && (!matches([rebuilt.spreadDx, rebuilt.renderedWidth], [committed.spreadDx, committed.renderedWidth], 2)))
          note(`spread-hit:${committed.nodeId} drawn=${committed.spreadDx} rebuilt=${rebuilt.spreadDx}`);
      }
    }
    // rustOffsetPatch moves captured globals at publication; the rebuilt captures are their ground truth.
    if (compareCaptures && reference) for (const [id, committed] of drawn.capturedGlobals) {
      const rebuilt = shadowCaptures.get(id);
      if (!rebuilt) note(`captured drawn, not rebuilt: ${id}`);
      else if (!matches(rebuilt.drawn, committed.drawn) || !matches(rebuilt.g, committed.g) ||
        !matches([rebuilt.parentTy], [committed.parentTy], 1)) note(`captured:${id}`);
    }
    // rustWireSpreadPatch: every shift the shadow walk banked is the committed bank's, the patched ones included,
    // and the live map the input side reads between builds holds the same.
    if (shadowSpread && reference) {
      const bank = committedSpread.dx ?? EMPTY_SPREAD;
      if (shadowSpread.size !== bank.size) note(`spread-bank: ${bank.size} committed, ${shadowSpread.size} rebuilt`);
      if (liveSpreadCommitted && shadowSpread.size !== spreadDxByNode.size)
        note(`spread-live: ${spreadDxByNode.size} live, ${shadowSpread.size} rebuilt`);
      for (const [id, dx] of shadowSpread) {
        const committed = bank.get(id), live = spreadDxByNode.get(id);
        if (committed === undefined || !matches([dx], [committed], 1))
          note(`spread:${id} drawn=${committed ?? "none"} rebuilt=${dx}${spreadMoves?.has(id) ? " moved" : ""}`);
        else if (liveSpreadCommitted && (live === undefined || !matches([dx], [live], 1)))
          note(`spread-live:${id} live=${live ?? "none"} rebuilt=${dx}`);
      }
    }
    stats.mismatches += mismatches;
    if (notes.length && stats.log.length < 16)
      stats.log.push({ run: stats.runs, revision: current.revision, clock: drawnClock, notes, recent: stats.recent.slice() });
  }

  /** What a verify note disagreed about: its leading tag, or the command kind in an `owner:kind:ordinal` key. */
  function verifyNoteKind(detail: string): string {
    const tagged = /^(hit-clip|spread-hit|spread-bank|spread-live|spread|hit|text|captured|clip|shadow build|commands)\b/.exec(detail);
    if (tagged) return tagged[1];
    const keyed = /:(quad|ninePatch|texturedMesh|polyline|clipPush|kind):/.exec(detail + ":");
    return keyed ? keyed[1] : /command count/.test(detail) ? "command-count" : "other";
  }

  /**
   * rustIdleInRust: why this frame cannot be presented from the installed idle descriptors, or null. The patch path
   * planning the same frame would draw nothing but the idle loops' poses: no tween, opacity, source or offset
   * sample, no landing, the committed overrides, and nothing in flight.
   */
  function idleLaneBlocked(): string | null {
    if (!retainedMode || !retainedValid || !retained || !pixi || !snapshot || readiness !== "ready") return "invalid-retained-state";
    if (asyncSubmissionRevision !== null) return "in-flight";
    const mask = visual.frameSampleMask;
    if (mask !== SAMPLE_LOCAL_ANIM) {
      if (mask === SAMPLE_NONE) return "no-anim";
      if (mask & SAMPLE_TRANSFORM) return "tween";
      if (mask & SAMPLE_SOURCE) return "source-swap";
      if (mask & (SAMPLE_OPACITY | SAMPLE_SELF_OPACITY)) return "opacity";
      return "unsupported-sample";
    }
    if (visual.opacityPatchIds.size || visual.sourceSampledIds.size) return "pending-samples";
    if (visual.transformOverrides.size) {
      if (!fast.heldOverridePatch || !committedOverrides || !sameTransformOverrides(visual.transformOverrides, committedOverrides))
        return "transform-overrides";
      const ancestors = overrideAncestors(visual.transformOverrides, snapshot.scene.nodes);
      for (const root of snapshot.build.localAnimFrames.keys()) if (ancestors.has(root)) return "anim-over-override";
    }
    if (interaction.offsetPending || !interaction.cosmeticOffsetsMatch(snapshot) || Number.isFinite(interaction.offsetRampDeadline))
      return "offsets";
    if (visual.landingArms.length > 0 || visual.hasOpenLanding()) return "landing";
    return null;
  }
  /**
   * rustIdleInRust: present an idle-only frame through the idle lane (the scheduler's `presentIdleFrame` port, and
   * the diagnostic clock). False: the caller patches or builds it as before.
   */
  function presentIdleFrame(at: number): boolean {
    if (!idleLane || !state || !snapshot || snapshot.stateRevision !== state.revision || scheduler.buildRequired) return false;
    const presented = lifecycle ? lifecycle.phase("pixi", () => idleLane!.tryFrame(at)) : idleLane.tryFrame(at);
    if (presented) publishIdleFrame(at);
    return presented;
  }
  /** rustIdleInRust: the bookkeeping of a frame Rust presented; the frame identity is the drawn clock. */
  function publishIdleFrame(at: number): void {
    frameEpoch++;
    drawnClock = at;
    idleRustFrames++;
    signalDiagnosticWake();
    lifecycle?.finish("completed", completedDraws());
    if (contentTrace && snapshot) console.timeStamp(`cc:content:${snapshot.stateRevision}:${snapshot.buildEpoch}:${frameEpoch}`);
    startupCompletionHook?.();
  }

  function tryRetainedPatch(at: number): boolean {
    if (!state || !snapshot || snapshot.stateRevision !== state.revision || !pixi) {
      retainedDecline = "invalid-retained-state"; return false;
    }
    if (scheduler.buildRequired) { retainedDecline = "build-requested"; return false; }
    // rustIdleInRust: plan against the pose Rust drew last, not the last one this side committed.
    idleLane?.sync();
    retainedDecline = "plan-unsupported";
const traceId = nextTraceFrame();
    const planStarted = rustPhaseTimingMode ? performance.now() : 0;
    const plan = traceId === null ? () => planRetainedSample(state!) : () => tracePhase(traceId, "patch", () => planRetainedSample(state!));
    const patch = lifecycle ? lifecycle.phase("patch", plan) : plan();
    if (rustDiagnosticMode) retainedPlanCount++;
    if (rustPhaseTimingMode) retainedPlanMs += performance.now() - planStarted;
    if (!patch) { retainedPatchFallbacks++; return false; }
    if (visual.landingArms.length > 0 || (visual.hasOpenLanding() && !landingRidesPatch(patch) &&
      (patch.movedRoots > 0 || patch.hits.length > 0 || patch.nodeMatrices.length > 0))) {
      retainedDecline = "landing-requires-full-build"; retainedPatchFallbacks++; return false;
    }
    const landingCandidate = visual.captureLandingPresentation(state, at,
      landingRidesPatch(patch) ? landingCapturesFor(patch, snapshot) : snapshot.capturedGlobals, landingLiftsFor(patch, snapshot));
    let committed: PresentationResult;
    let phaseSubmissionId: number | undefined;
    try {
      const submitted = submitRetainedPatch(patch, traceId);
      phaseSubmissionId = submitted.phaseSubmissionId;
      const result = submitted.result;
      if (isPromiseLike<PresentationResult>(result)) { trackAsyncRetainedPatch(result, patch, at, undefined, phaseSubmissionId, landingCandidate); retainedDecline = "async-in-flight"; return false; }
      if (!result.presented) { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "refused");
        patchLost(patch, true); retainedPatchFallbacks++; retainedDecline = "presentation-refused"; return false; }
      committed = result;
    } catch { if (phaseSubmissionId !== undefined) producerReasons!.finishRetainedIfOpen(phaseSubmissionId, "failed");
      patchLost(patch, true); retainedPatchFallbacks++; retainedDecline = "presentation-error"; return false; }
    publishRetainedPatch(patch, at, undefined, committed, landingCandidate);
    if (rustExecutionPhaseMode) producerReasons!.finishRetainedIfOpen(phaseSubmissionId!, "committed");
    return true;
  }

  function logicalPaintRows(): string[] {
    idleLane?.sync();
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
    ...(backend === "rust" && textDegradations.size
      ? { degradations: Object.fromEntries(textDegradations) } : {}),
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
        opacitySampleCount: visual.opacitySampledIds.size, sourceSampleCount: visual.sourceSampledIds.size,
        settledOverrideReleases: visual.stats().settledOverrideReleases } : {}),
      ...(rustPhaseTimingMode ? { retainedPlanMs, producerBuildMs, wireSpanLoopMs, wireSpreadPublishMs } : {}),
      ...(fast.lazyComposition ? { lazyCompositionIndexBuilds, lazyCompositionVerifyMismatches } : {}),
      ...(fast.snapshotReuse ? { snapshotNodeReuses, staticSkipRootReuses, rewardFocusSkips } : {}),
      // rustSceneIndex: reward-focus candidates/the static-bg skip-root memo (both here) plus
      // interactionRuntime's own hand-present/cover-above candidates (item 3) share one counter.
      ...(fast.sceneIndex ? { sceneIndexVerifyMismatches: sceneIndexVerifyMismatches + interaction.sceneIndexVerifyMismatches } : {}),
      ...(fast.raiseIndexCache ? { raiseIndexCacheVerifyMismatches: interaction.raiseIndexCacheVerifyMismatches } : {}),
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
      ...(rustDiagnosticMode ? { rustCompositionRefusals: { reasons: { ...compositionRefusals },
        roots: structuredClone(compositionRefusalRoots),
        overrides: [...visual.transformOverrides.entries()].slice(0, 16).map(([id, m]) => {
          const g: number[] = [1, 0, 0, 1, 0, 0];
          const streamed = state && visual.streamedGlobalInto(state, id, g);
          return `${describeNode(id)} override=${m.map((v) => +v.toFixed(3)).join(",")} streamed=${streamed ? g.map((v) => +v.toFixed(3)).join(",") : "none"}`;
        }),
        anims: [...visual.localAnims.keys()].slice(0, 16).map((id) => describeNode(id)) } } : {}),
      ...(scheduler.coalesceStats() ? { rustCoalescedBuilds: scheduler.coalesceStats() } : {}),
      ...(backend === "rust" ? { rustIdleScheduler: scheduler.idleStats() } : {}),
      ...(hiddenWalkMode ? { rustHiddenWalk: { rows: hiddenWalkRows.slice(), overflow: hiddenWalkOverflow } } : {}),
      webglVersion: (() => { const gl = (pixi?.app.renderer as unknown as { gl?: WebGLRenderingContext })?.gl; return gl ? gl.getParameter(gl.VERSION) : null; })(),
      renderer: (() => { const gl = (pixi?.app.renderer as unknown as { gl?: WebGLRenderingContext })?.gl; return gl ? gl.getParameter(gl.RENDERER) : null; })(),
      ageMs: performance.now() - createdAt, buildEpoch, commands: list.count, pixiScene: retainedMode ? "retained" : "legacy", idleCadence: displayPaced ? "display" : "authored",
      paintOrderReuse: paintOrderReuse ? 1 : 0,
      ...(backend === "rust" ? { rustOmitStaticPixelCaches, rustSkipHiddenHitCandidates,
        rustStaticAdmissionPhase: rustStaticAdmissionPhaseMode, rustFast: { ...fast },
        rustTextPrepCache: { textPrep: textPrepCache?.stats() ?? null, fontCheck: fontCheckCache?.stats() ?? null },
        // Exposed unconditionally (not gated on fast.textEvict) so an ABAB against `rustTextEvict=0` can read
        // `resources` in both arms: flat while the switch is on, growing without bound while it is off.
        rustTextEvict: { evictions: pixi?.rustTextEvictions ?? 0, resources: pixi?.rustTextCacheResources ?? 0 } } : {}),
      ...(fast.damagePresent && pixi?.rustDamage ? { rustDamage: pixi.rustDamage } : {}),
      ...(backend === "rust" ? { rustIdleInRust: idleLane ? { ...idleLane.stats(), rendererFrames: idleRustFrames,
        executor: (pixi as unknown as { rustIdleStats?: unknown } | null)?.rustIdleStats ?? null }
        : fast.idleInRust ? "unavailable" : "off" } : {}),
      ...(lazyCompositionVerifyFirstMismatch ? { lazyCompositionVerifyFirstMismatch } : {}),
      ...(fast.heldOverridePatch ? { rustHeldOverride: { heldOverridePatches, heldOverrideDeclines: { ...heldOverrideDeclines }, ...(fast.verify ? { heldOverrideVerifyRuns: heldVerify.runs, heldOverrideVerifyMismatches: heldVerify.mismatches, heldOverrideVerifyMaxError: heldVerify.maxError, heldOverrideVerifyFirstMismatch: heldVerify.firstMismatch, heldOverrideVerifyLog: heldVerify.log.map((entry) => ({ ...entry, notes: [...entry.notes], recent: [...entry.recent] })) } : {}) } } : {}),
      ...(fast.offsetPatch ? { rustOffsetPatch: { offsetPatches, offsetPatchedNodes, wireCapturedPatches, offsetDeclines: { ...offsetDeclines },
        offsetDeclineTypes: { ...offsetDeclineTypes },
        ...(fast.verify ? { verifyRuns: offsetVerify.runs, verifyMismatches: offsetVerify.mismatches, verifyMaxError: offsetVerify.maxError,
          verifyFirstMismatch: offsetVerify.firstMismatch, verifyKinds: { ...offsetVerify.kinds },
          verifyLog: offsetVerify.log.map((entry) => ({ ...entry, notes: [...entry.notes], recent: [...entry.recent] })) } : {}) } } : {}),
      ...(fast.tweenRootPatch && fast.heldOverridePatch ? { rustTweenRootPatch: { patches: tweenRootPatches, roots: tweenRootsPatched,
        visited: tweenRootVisited, declines: { ...tweenDeclines },
        ...(fast.verify ? { verifyRuns: tweenVerify.runs, verifyMismatches: tweenVerify.mismatches, verifyMaxError: tweenVerify.maxError,
          verifyFirstMismatch: tweenVerify.firstMismatch, verifyKinds: { ...tweenVerify.kinds },
          verifyLog: tweenVerify.log.map((entry) => ({ ...entry, notes: [...entry.notes], recent: [...entry.recent] })) } : {}) } } : {}),
      ...(fast.textPatch ? { rustTextPatch: { patches: textPatches, records: textPatchedRecords, declines: { ...textPatchDeclines },
        executor: (pixi as { rustTextPatchStats?: unknown } | null)?.rustTextPatchStats ?? null,
        ...(fast.verify ? { verifyRuns: textVerify.runs, verifyMismatches: textVerify.mismatches, verifyMaxError: textVerify.maxError,
          verifyFirstMismatch: textVerify.firstMismatch, verifyKinds: { ...textVerify.kinds },
          verifyLog: textVerify.log.map((entry) => ({ ...entry, notes: [...entry.notes], recent: [...entry.recent] })) } : {}) } } : {}),
      ...(!fast.textPatch && backend === "rust" ? { rustTextPatchOff: { executor:
        (pixi as { rustTextPatchStats?: unknown } | null)?.rustTextPatchStats ?? null } } : {}),
      ...(fast.wireSpreadPatch ? { rustWireSpreadPatch: { patches: wireSpreadPatches, spans: wireSpreadSpans, shifted: wireSpreadShifted,
        visited: wireSpreadVisited, declines: { ...wireSpreadDeclines },
        ...(fast.verify ? { verifyRuns: spreadVerify.runs, verifyMismatches: spreadVerify.mismatches, verifyMaxError: spreadVerify.maxError,
          verifyFirstMismatch: spreadVerify.firstMismatch, verifyKinds: { ...spreadVerify.kinds },
          verifyLog: spreadVerify.log.map((entry) => ({ ...entry, notes: [...entry.notes], recent: [...entry.recent] })) } : {}) } } : {}),
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
        if (!snapshot || !(presentIdleFrame(at) || tryRetainedPatch(at))) paint(current, "clock", retainedDecline);
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
      // rustCoalescedBuilds: an open request is newer than any build that already presented this revision, so it
      // builds here, unless it may wait for the next tick (not urgent, and this frame already built or patched).
      const honourRequest = scheduler.buildRequested && !scheduler.buildRequestMayWait;
      const presented = (completedAsync && !honourRequest) || tryRetainedWire(next, at) || paint(next, "wire", retainedDecline); if (presented) {
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
    setStretch(factor) { stretch = factor; visual.setStretch(factor); paintLocal(); },
    setHeldCard(id, _x, y, mode) { interaction.setHeldCard(id, y, mode); }, setRaiseHandCards: interaction.setRaiseHandCards,
    setHandRaiseChrome(next) { handRaiseChrome = next; paintLocal(); },
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
    setStaticBackgroundSource(source, ready) { staticBackground = source; staticBackgroundReady = ready; if (!source) ready?.(false); paintLocal(); },
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
