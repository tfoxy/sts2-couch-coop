import type { DrawList } from "@godot-scene-web/canvas";
import type { PixiDrawListRenderer, PixiDrawListRendererStats, PixiScenePlan, PixiScenePatch, PixiTextOutcomes, PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import type { ClipTranslatingScenePatch, MirrorDrawExecutorFactory } from "./createPixiMirrorRenderer";
import { offsetRustTextCarrierTransform } from "@/mirror/renderer/semanticTextLayout";
import { createBitmapTextMethod } from "./textMethods/bitmap";
import { createTextResourceEvictionTracker } from "./textMethods/textResourceEviction";
import { carrierForMsdfRun, createMsdfRuntime, msdfGlyphKey, type MsdfRunRecord } from "./textMethods/msdf";
import { MsdfAtlas } from "./textMethods/msdfAtlas";
import type { TextInkRaster, CorpusInput, CorpusRow } from "./textMethods/types";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import type { RustTextCarrier, RustResourceUpdate } from "@godot-scene-web/canvas/rust-prototype";
import { MsdfGenerator } from "@godot-scene-web/canvas/msdf-generator";
import { emitBusyStartupEvent } from "./busyStartupEvent";
import { ensureFontFace, loadMirrorFont, mirrorFontRegistration } from "@/mirror/fonts";
import type { ProducerExecutorEvent } from "./producerBuildReasons";
import { requireSingleProfileMode, type ProfileIdentity } from "./couchCanvasProfile";
import { rustFastFlagsFromLocation, rustPresentModeFromLocation, type RustPresentMode } from "./rustFastFlags";

type RustWasmRenderer = {
  backend: string;
  resize(width: number, height: number): void;
  upload_rgba_batch(bytes: Uint8Array): number;
  admit_scene(bytes: Uint8Array): string;
  apply_patch(bytes: Uint8Array): string;
  set_phase_operation_id?(id: number): void;
  set_phase_identity?(runId: string, rendererInstanceId: string, operationId: number): void;
  gpuTimerCapability?(): string;
  /** rustFast `drawStateDedupe` (being added in parallel): set once after `create`, never polled for support. */
  set_draw_state_dedupe?(enabled: boolean): void;
  /** rustDamagePresent: optional in older glue, so its presence is the capability probe. */
  set_damage_present?(enabled: boolean): void;
  set_damage_verify?(enabled: boolean): void;
  /** rustTextPatch capability: `apply_patch` accepts a patch `resources` list. Undefined on older glue. */
  readonly patch_resources?: boolean;
  /** rustPresent: the mode this engine instance actually presents through. Undefined on glue built before present modes existed. */
  readonly present_mode?: string;
  present(): Promise<string>;
  dispose(): void;
};
export type ResourcePixels = { key: string; width: number; height: number; pixels: Uint8Array };
type RetainedPatchEncoding = { bytes: Uint8Array; scene: RustSceneSnapshot; changedIndexes: readonly number[];
  /** rustTextPatch (newer GSW only): raster pixels the patched labels draw, and whether the resource list changed. */
  textUploads?: readonly ResourcePixels[]; resourcesChanged?: boolean;
  /** rustTextPatch: the records this patch re-emitted and the carriers it resolved for them (kept for verify). */
  preparedTexts?: readonly { record: PixiTextRecord; carrier: RustTextCarrier }[] };
type RustSceneSnapshot = { version: 2; revision: number; width: number; height: number; designWidth: number; designHeight: number; resources: { key: string; width: number; height: number }[]; commands: Record<string, unknown>[] };
type Serializer = {
  encodeRustScene(input: {
    drawList: DrawList<string>; revision: number; width: number; height: number; designWidth: number; designHeight: number;
    resolveTexture(texture: string): { key: string; width: number; height: number } | null;
    texts: readonly PixiTextRecord[]; resolveText(record: PixiTextRecord): RustTextCarrier | null;
    plan?: PixiScenePlan;
    /** rustFast `fastSerializer` (being added in parallel in GSW). Feature-detected by always being optional. */
    fast?: boolean;
  }): { bytes: Uint8Array; scene: RustSceneSnapshot; resources: { key: string; width: number; height: number }[]; textUploads: ResourcePixels[];
    unsupportedCommands: number; omittedKinds?: Record<string, number> };
  encodeRustResources(items: readonly ResourcePixels[]): Uint8Array;
  encodeRustResourceUpdates(items: readonly RustResourceUpdate[]): Uint8Array;
  encodeRustPatch(previous: RustSceneSnapshot, next: RustSceneSnapshot, hint?: unknown, options?: { fast?: boolean }): Uint8Array | null;
  encodeRustRetainedPatch?(base: RustSceneSnapshot, revision: number,
    updates: readonly { id: string; command: Record<string, unknown>; localTransform?: readonly number[] }[],
    groupTransforms?: readonly { id: string; transform: readonly number[] }[], profile?: undefined,
    options?: { texts?: readonly { record: PixiTextRecord; carrier: RustTextCarrier }[] }): RetainedPatchEncoding | null;
  /** rustTextPatch: the serializer encodes `options.texts` (a re-prepared label). Absent on an older GSW. */
  RUST_RETAINED_TEXT_PATCH?: boolean;
  /**
   * rustFast `fastSerializer` (being added in parallel in GSW): a cached command-id → command-index map for
   * `scene`, so the executor does not have to rebuild one by walking `scene.commands` itself. Optional and
   * feature-detected; absent on a GSW build that predates it, in which case the executor rebuilds as before.
   */
  rustSceneCommandIndex?(scene: RustSceneSnapshot): ReadonlyMap<string, number>;
};

const blankStats = (): PixiDrawListRendererStats => ({ frames: 0, completedFrames: 0, objects: 0, created: 0, updated: 0, destroyed: 0,
  textures: 0, frameTextures: 0, gpuTextures: 0, gpuTextureSlots: 0, textureLoads: 0, textureFailures: 0, resourcePending: 0,
  textRasterizations: 0, textInvalidations: 0, refusedEffects: 0, refusedGlyphs: 0, blockedPendingFrames: 0, blockedRefusedFrames: 0,
  sceneAdmissions: 0, scenePatches: 0, sceneChangedObjects: 0, scenePreflightFailures: 0, scenePresentationFailures: 0,
  contextReady: true, presentationValid: false, omittedClipMasksLastSubmission: 0, omittedClipMasksTotalSubmissions: 0,
  skippedGlSubmissions: 0, diagnosticQuadSubmissions: 0 });

function parse<T>(value: string): T { return JSON.parse(value) as T; }
const rustDebug = new URLSearchParams(window.location.search).get("rustDebug") === "1";
function logRust(...values: unknown[]): void { if (rustDebug) console.info("[rust-prototype]", ...values); }

/** The experimental executor consumes the producer's existing DrawList; browser policy and input stay in Couch. */
export const createRustDrawListExecutor: MirrorDrawExecutorFactory = async ({ canvas, width, height, designWidth, designHeight, startupRendererInstance, onInvalidate, profile }) => {
  const startupEvent = typeof (window as unknown as { __benchBusyStartupEvent?: unknown }).__benchBusyStartupEvent === "function"
    ? emitBusyStartupEvent : null;
  const startupResourceHook = (window as unknown as { __benchStartupResourceEvent?: unknown }).__benchStartupResourceEvent;
  const startupResourceEvent = typeof startupResourceHook === "function"
    ? startupResourceHook as (name: string, detail: unknown) => void : null;
  const fast = rustFastFlagsFromLocation("rust");
  // rustPresent: not part of `fast`, so `rustFast=0` never changes the present path (see rustFastFlags.ts).
  const presentMode = rustPresentModeFromLocation("rust");
  const zeroCopyPixels = new URLSearchParams(window.location.search).get("rustZeroCopyPixels") === "1";
  const textInkReadFrequently = new URLSearchParams(window.location.search).get("rustTextInkReadFrequently") === "1";
  const textInkCorpus = new URLSearchParams(window.location.search).get("rustTextInkCorpus") === "1";
  const textInkDiagnostics = new URLSearchParams(window.location.search).get("rustTextInkDiagnostics") === "1" || textInkCorpus;
  (window as unknown as { __mirrorRustPixelControl?: boolean }).__mirrorRustPixelControl = zeroCopyPixels;
  const cardAtlasPath = "/res/images/atlases/card_atlas_0.png";
  const isCardAtlas = (key: string) => new URL(key, window.location.href).pathname === cardAtlasPath;
  let cardAtlasFirstSubmissionRecorded = false;
  startupEvent?.("rust.executorStart", { width, height, designWidth, designHeight });
  let surfaceWidth = width, surfaceHeight = height;
  let sceneDesignWidth = designWidth, sceneDesignHeight = designHeight;
  const startedAt = performance.now();
  // URL overrides are retained for replay/profiling fixtures. The normal app imports the
  // generated glue and GSW serializer through Vite so both ship with the frontend.
  const wasmUrl = import.meta.env.VITE_RUST_PROTOTYPE_MODULE_URL;
  const sceneUrl = import.meta.env.VITE_RUST_SCENE_SERIALIZER_URL;
  const [wasmModule, serializer] = await Promise.all([
    (wasmUrl ? import(/* @vite-ignore */ wasmUrl) : import("@couchcoop/rust-prototype-glue")) as Promise<{ default: () => Promise<{ memory?: WebAssembly.Memory }>; RustRenderer: { create(canvas: HTMLCanvasElement): Promise<RustWasmRenderer>;
      /** rustPresent: optional in older glue, so its presence is the capability probe. */
      createWithPresent?(canvas: HTMLCanvasElement, mode: RustPresentMode): Promise<RustWasmRenderer> } }>,
    (sceneUrl ? import(/* @vite-ignore */ sceneUrl) : import("@godot-scene-web/canvas/rust-prototype")) as Promise<Serializer>,
  ]);
  // rustOffsetPatch: whether this serializer encodes a clip translation (a `clipPush` replacement that keeps the
  // clip's size). An older one refuses it, which would turn every patch carrying a clip move into a full admission.
  /** rustOffsetPatch: each clip push's rect as the last full admission placed it. */
  let admittedClipRects = new Map<string, number[]>();
  // Asked once, on first use.
  let clipProbe: boolean | undefined;
  const translatesClips = () => clipProbe ??= (() => {
    const encode = serializer.encodeRustRetainedPatch;
    if (!encode) return false;
    const clip = { id: "c0", kind: "clipPush", rect: [0, 0, 1, 1], radius: 0, outset: 0 };
    try {
      return encode({ version: 2, revision: 1, width: 1, height: 1, designWidth: 1, designHeight: 1, resources: [],
        commands: [clip, { id: "c1", kind: "clipPop" }] }, 2, [{ id: "c0", command: { ...clip, rect: [1, 0, 1, 1] } }]) !== null;
    } catch { return false; }
  })();
  const importedAt = performance.now();
  startupEvent?.("rust.moduleImported", { elapsedMs: importedAt - startedAt });
  const wasmExports = await wasmModule.default();
  const compiledAt = performance.now();
  startupEvent?.("rust.wasmInitialized", { elapsedMs: compiledAt - startedAt });
  logRust("wasm initialized");
  // rustDamagePresent diagnostics: the counters the CURRENT engine last reported (a restored engine starts at zero).
  type RustDamageStats = { partialPresents: number; fullPresents: number; skippedPresents: number; partialPixels: number;
    partialDraws: number; verifyMismatches: number; verifyChecks: number };
  let rustDamageStats: RustDamageStats | null = null;
  let rustLastDamage: string | null = null;
  let damagePresent = false;
  // rustPresent diagnostics: `appliedPresentMode` is set synchronously at creation (so it is correct even before
  // any present); `rustLastPresentMode`/blit counters are mirrored from each present result, same as damage above.
  let appliedPresentMode: RustPresentMode = "surface";
  let rustLastPresentMode: string | null = null;
  let rustBlitPixelsTotal = 0;
  let rustLastBlitPixels: number | null = null;
  let presentModeFallbackNoted = false;
  /**
   * rustPresent: `createWithPresent` is newer glue — absent (or mode "surface") means the mode stays "surface",
   * today's `create(canvas)` call, unchanged. A requested mode the glue can't honour falls back the same way,
   * once, with a console note (never thrown: an experimental present mode must not block the stage from coming up).
   */
  const createEngine = (): Promise<RustWasmRenderer> => {
    if (presentMode !== "surface" && wasmModule.RustRenderer.createWithPresent) {
      appliedPresentMode = presentMode;
      return wasmModule.RustRenderer.createWithPresent(canvas, presentMode);
    }
    if (presentMode !== "surface" && !presentModeFallbackNoted) {
      presentModeFallbackNoted = true;
      console.info(`[rust-prototype] rustPresent=${presentMode} unsupported by this glue; using surface present`);
    }
    appliedPresentMode = "surface";
    return wasmModule.RustRenderer.create(canvas);
  };
  /**
   * Every engine-level setting, applied to each engine this executor creates — at startup AND after a WebGL
   * context restore, which builds a fresh engine with default (off) settings. Each method is optional in the
   * glue, so a build that predates one is a silent no-op; settings are set once per engine, never polled.
   */
  const configureEngine = (target: RustWasmRenderer) => {
    // rustFast `drawStateDedupe`.
    if (fast.drawStateDedupe) target.set_draw_state_dedupe?.(true);
    // rustDamagePresent: the renderer keeps its picture and redraws only what a patch changes; a present with
    // nothing to change skips the GPU and leaves the canvas showing the previous frame.
    damagePresent = fast.damagePresent && typeof target.set_damage_present === "function";
    if (damagePresent) {
      target.set_damage_present!(true);
      // rustFastVerify: the renderer re-derives each partial plan by brute force (a miss is redrawn whole and
      // counted). It shares the planner's bounds model, so it catches bookkeeping slips, not a wrong model.
      if (fast.verify) target.set_damage_verify?.(true);
    }
    rustDamageStats = null; rustLastDamage = null;
    rustLastPresentMode = null; rustBlitPixelsTotal = 0; rustLastBlitPixels = null;
  };
  let engine = await createEngine();
  configureEngine(engine);
  const executionPhases = new URLSearchParams(window.location.search).get("rustExecutionPhases") === "1";
  requireSingleProfileMode(!!profile, executionPhases);
  if (executionPhases && typeof engine.set_phase_operation_id !== "function")
    throw new Error("Rust execution phase diagnostic requires matching WASM glue");
  if (profile && typeof engine.set_phase_identity !== "function")
    throw new Error("canvas-profile/1 requires matching WASM glue with set_phase_identity");
  const setProfileIdentity = (identity: ProfileIdentity, operationId = identity.operationId) =>
    engine.set_phase_identity!(identity.runId, identity.rendererInstanceId, operationId);
  const createdAt = performance.now();
  startupEvent?.("rust.surfaceCreated", { elapsedMs: createdAt - startedAt,
    width: canvas.width, height: canvas.height });
  // Cache wasm-backed metadata before any async present can hold a mutable wasm borrow.
  const backendName = engine.backend;
  logRust("surface created", backendName, canvas.width, canvas.height);
  const stats = blankStats();
  const textures = new Map<string, ResourcePixels>();
  const pending = new Map<string, Promise<void>>();
  const pendingDetails = new Map<string, { phase: "fetch" | "body" | "decode" | "readPixels"; startedAt: number; status?: number; bytes?: number }>();
  const failures = new Map<string, string>();
  const uploaded = new Set<string>();
  const uploadedPixels = new Map<string, ResourcePixels>();
  const pixelRevisions = new Map<string, number>();
  // rustTextEvict: ~64-128 per the WP1 spec; the middle of that range gives label-toggle protection without
  // letting the Bitmap cache run far ahead of what one screen's worth of text actually needs.
  const TEXT_EVICTION_POOL_LIMIT = 96;
  const textEvictionTracker = createTextResourceEvictionTracker(TEXT_EVICTION_POOL_LIMIT);
  let textEvictions = 0;
  // rustTextEvict: refcounted Bitmap keys an ENCODED-BUT-NOT-YET-SETTLED `submit()` call needs, the same
  // pattern `inFlightGlyphPages` already uses for MSDF. A key's encode (and the upload-skip decision that goes
  // with it: `uploaded.has(key)`) happens synchronously at call time, before that submission is even queued —
  // so a second `submit()` can run its own encode, pin its keys, and queue behind the first, ALL before the
  // first submission's continuation (including eviction) ever executes. Pinning here is what lets eviction see
  // a key a still-in-flight sibling submission needs, independent of whatever ordering guarantee the caller
  // above this executor does or doesn't provide.
  const inFlightTextKeys = new Map<string, number>();
  let lastRevision = 0;
  let nextRevision = 0;
  let nextPresentOnlyPhaseId = 0x80000000; // Legacy rustExecutionPhases trace IDs only.
  let committedScene: Uint8Array | null = null;
  let committedTypedScene: RustSceneSnapshot | null = null;
  let committedCommandIndexes = new Map<string, number>();
  let committedResourceBuffer: Uint8Array | null = null;
  let committedResourceByteLength = 0;
  let committedResources: ResourcePixels[] = [];
  let committedRevision: number | null = null;
  let submissionTail: Promise<void> = Promise.resolve();
  let retainedPatchInFlight = false;
  let resizeFailure: string | null = null;
  const msdfAtlas = new MsdfAtlas();
  const msdfFallbackReasons: Record<string, number> = {};
  let msdfGlyphRunsEncoded = 0, msdfGlyphRunPresentations = 0, msdfGlyphRunsLastPresented = 0;
  const inFlightGlyphPages = new Map<string, number>();
  let msdfFrameScheduled = false;
  const msdfRuntime = mirrorSettings.textMethod === "msdf" ? (() => {
    const wasmModuleUrl = import.meta.env.DEV
      ? new URL("/app/msdf_generator.js", window.location.href).href
      : new URL("./msdf_generator.js", import.meta.url).href;
    return createMsdfRuntime(() => { scheduleMsdfFrame(); onInvalidate(); }, wasmModuleUrl,
      { generator: new MsdfGenerator({ wasmModuleUrl,
        createWorker: () => new Worker(new URL("./textMethods/msdfGeneratorWorker.ts", import.meta.url), { type: "module" }) }) });
  })() : null;
  const glyphPages = (scene: RustSceneSnapshot | null): string[] => scene?.commands
    .filter((command) => command.kind === "glyphRun" && typeof command.atlas === "string")
    .map((command) => command.atlas as string) ?? [];
  function scheduleMsdfFrame(): void {
    if (!msdfRuntime || disposed || msdfFrameScheduled) return;
    msdfFrameScheduled = true;
    requestAnimationFrame(() => {
      if (disposed) { msdfFrameScheduled = false; return; }
      const operation = submissionTail.then(() => {
        const lease = msdfRuntime.takeGeneration();
        if (lease) msdfAtlas.enqueue(lease.keys, lease.result.tiles,
          () => msdfRuntime.finishGeneration(lease));
        if (!msdfAtlas.hasWork()) return 0;
        const pins = new Set([...glyphPages(committedTypedScene), ...inFlightGlyphPages.keys()]);
        const result = msdfAtlas.flush((updates) => {
          const batch = serializer.encodeRustResourceUpdates(updates);
          engine.upload_rgba_batch(batch);
          wasmUploadCalls++; wasmUploadBytes += batch.byteLength; wasmBytesSent += batch.byteLength;
        }, pins);
        return result.ready;
      });
      submissionTail = operation.then(() => undefined, () => undefined);
      void operation.then((ready) => { if (ready) onInvalidate(); })
        .catch((error) => { msdfFallbackReasons["atlas-upload"] = (msdfFallbackReasons["atlas-upload"] ?? 0) + 1;
          logRust("MSDF atlas upload", error); })
        .finally(() => { msdfFrameScheduled = false; if (msdfAtlas.hasWork()) scheduleMsdfFrame(); });
    });
  }
  const contextLost = (event: Event) => {
    event.preventDefault();
    stats.contextReady = false;
    msdfAtlas.resetResidency();
    uploaded.clear(); uploadedPixels.clear();
    committedTypedScene = null; committedScene = null; committedRevision = null;
  };
  const contextRestored = () => {
    const operation = submissionTail.then(async () => {
      if (disposed) return;
      msdfAtlas.resetResidency();
      uploaded.clear(); uploadedPixels.clear();
      committedTypedScene = null; committedScene = null; committedRevision = null;
      engine.dispose();
      engine = await createEngine();
      configureEngine(engine);
      resizeFailure = null;
      stats.contextReady = true;
      onInvalidate();
    });
    submissionTail = operation.then(() => undefined, () => undefined);
    void operation.catch((error) => {
      stats.contextReady = false;
      resizeFailure = String(error);
    });
  };
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);
  let textCount = 0;
  type TextInkSubmission = { revision: number; sceneRevision: number | null; cacheMisses: number; rasters: TextInkRaster[] };
  const textInkDiagnosticEventLimit = 512;
  const textInkDiagnosticEvents: TextInkRaster[] = [];
  let textInkDiagnosticOverflow = false;
  let textInkCurrentSubmission: TextInkSubmission | null = null;
  let textInkLastMissSubmission: TextInkSubmission | null = null;
  type PreparedFontAsset = { family: string; url: string; weight: string | null; style: string | null;
    sha256: string; bytes: number; registered: { url: string; weight: string | null; style: string | null;
      cssRule: string } };
  type FontPreparation = { accepted: boolean; assets: PreparedFontAsset[];
    rows: Array<{ index: number; recordKey: string; expected: FontMismatchSide; observed: FontMismatchSide;
      registered: ReturnType<typeof mirrorFontRegistration>; reason: string | null }>;
    unresolved: number[] };
  type FontMismatchSide = Pick<CorpusInput, "font" | "fontReady" | "fontSetStatus" | "fontAsset"> &
    { matchingFaces: CorpusInput["fontFaces"] };
  type FontMismatchEvidence = { rowIndex: number; recordKey: string; expected: FontMismatchSide;
    actual: FontMismatchSide; checks: { ready: boolean; asset: boolean; descriptorAndFaceSet: boolean } };
  const corpusRows: CorpusRow[] = [];
  const corpusLimit = 512, corpusByteLimit = 64 * 1024 * 1024;
  let corpusBytes = 0, corpusOverflow = false;
  let corpusSealed = false;
  let pinnedCorpus: { id: string; rows: CorpusRow[] } | null = null;
  let pinnedPrepared: { id: string; rows: CorpusRow[] } | null = null;
  let pinnedReplay: { id: string; rows: CorpusRow[] } | null = null;
  const pinnedPhoneReplay = new Map<boolean, { id: string; rows: CorpusRow[] }>();
  let lastFontMismatch: FontMismatchEvidence | null = null;
  let capturePreparation: FontPreparation | null = null;
  let importedPreparation: { corpusId: string; receipt: FontPreparation } | null = null;
  let productionCssBeforePreparation: Array<{ family: string; registration: ReturnType<typeof mirrorFontRegistration> }> | null = null;
  let preparedBaseline: CorpusRow[] | null = null;
  let disposed = false;
  let presentationValid = false;
  let wasmUploadCalls = 0, wasmAdmissionCalls = 0, wasmPatchCalls = 0, wasmPresentCalls = 0, wasmResizeCalls = 0;
  let wasmUploadBytes = 0, wasmSceneBytes = 0, wasmPatchBytes = 0, unsupportedCommands = 0;
  const omittedKinds: Record<string, number> = {};
  let wasmBytesSent = 0;
  let retainedPatchEncodes = 0, retainedPatchEncodeMs = 0, retainedPatchQueueWaitMs = 0, retainedPatchPresentWaitMs = 0;
  // rustTextPatch: committed patches that re-emitted a label, and those that also changed the resource list.
  let textPatchCommits = 0, textPatchResourceChanges = 0;
  // rustTextPatch under rustFastVerify: the record and carrier each committed text patch emitted, by command id.
  // A full admission re-emits every label, so it clears these.
  const committedTextCarriers = new Map<string, { record: PixiTextRecord; carrier: RustTextCarrier }>();
  let retainedPatchApplyMs = 0, sceneEncodeMs = 0, sceneDiffMs = 0, scenePatchApplyMs = 0;
  // rustFast WP3 counters: style-string cache (`textPrepCache`) and prefetch-skip (`snapshotReuse`) hit counts.
  let styleCacheHits = 0, styleCacheMisses = 0, prefetchSkips = 0;
  const styleStringCache = new WeakMap<PixiTextRecord["style"], string>();
  let rustDrawCalls: number | null = null, rustBufferCreations: number | null = null, rustTextureCreations: number | null = null;
  let rustUploadBytes: number | null = null, rustCompletedPresents: number | null = null, rustWasmCalls: number | null = null;
  let rustInstanceUploadBytes: number | null = null, rustIncrementalPatches: number | null = null, rustGeometryRebuilds: number | null = null;
  let rustMaxSampledTextures: number | null = null;
  let firstPresentMs: number | null = null;
  let appGl: WebGLRenderingContext | null = null;
  const app = { renderer: { get gl() { return appGl; } } } as unknown as PixiDrawListRenderer<string>["app"];
  const globals = window as unknown as { __mirrorRustFixture?: () => unknown; __mirrorRustFixtureChunk?: (kind: "scene" | "resources", offset: number, length: number) => unknown;
    __mirrorRustGpuTimerCapability?: unknown;
    __mirrorRustStats?: () => unknown; __mirrorRustRollbackProbe?: () => Promise<unknown>;
    __mirrorRustTextCorpus?: { prepareFonts(corpus?: unknown): Promise<FontPreparation>; snapshot(): Promise<unknown>;
      replay(corpus: unknown, inkReadFrequently: boolean): Promise<unknown>;
      replayPhone(corpus: unknown, inkReadFrequently: boolean): Promise<unknown>;
      chunk(kind: "capture" | "prepared" | "replay" | "phone-off" | "phone-on", id: string,
        index: number, offset: number, length: number): unknown;
      lastFontMismatch(): FontMismatchEvidence | null } };
  globals.__mirrorRustGpuTimerCapability = typeof engine.gpuTimerCapability === "function"
    ? parse<unknown>(engine.gpuTimerCapability()) : null;
  const fixtureEnabled = new URLSearchParams(window.location.search).get("rustFixtureDump") === "1";
  const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
    return btoa(binary);
  };
  const canonical = (value: unknown): string => {
    const seen = new WeakSet<object>();
    const normalize = (item: unknown): unknown => {
      if (item === null || typeof item === "string" || typeof item === "boolean") return item;
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (Array.isArray(item)) return item.map(normalize);
      if (typeof item === "object") {
        if (seen.has(item)) throw new Error("Cyclic Rust text corpus input");
        seen.add(item);
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(item).sort()) {
          const child = (item as Record<string, unknown>)[key];
          if (child !== undefined) result[key] = normalize(child);
        }
        seen.delete(item);
        return result;
      }
      throw new Error("Non-serializable Rust text corpus input");
    };
    return JSON.stringify(normalize(value));
  };
  const sha256 = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const textBytes = (value: string) => new TextEncoder().encode(value);
  const fontInfo = (record: PixiTextRecord): Omit<CorpusInput, "record"> => {
    const style = record.style as PixiTextRecord["style"] & Record<string, unknown>;
    const size = Number(style.fontSize ?? 16);
    const family = String(style.fontFamily ?? "sans-serif");
    const font = [style.fontStyle, style.fontVariant, style.fontWeight, `${size}px`, family].filter(Boolean).join(" ");
    const revision = record.resourceRevision;
    let fontAsset: CorpusInput["fontAsset"] = null;
    if (typeof revision === "string") {
      const separator = revision.indexOf(":");
      if (separator >= 0) {
        try {
          const value = JSON.parse(revision.slice(separator + 1)) as Record<string, unknown>;
          if (typeof value.family === "string" && typeof value.url === "string") fontAsset = {
            family: value.family, url: value.url,
            weight: typeof value.weight === "string" ? value.weight : null,
            style: typeof value.style === "string" ? value.style : null };
        } catch { /* An unknown revision is reported as a missing font asset. */ }
      }
    }
    const fontFaces: CorpusInput["fontFaces"] = [];
    document.fonts?.forEach((face) => {
      if (fontAsset && face.family.replaceAll('"', "") !== fontAsset.family.replaceAll('"', "")) return;
      fontFaces.push({ family: face.family, style: face.style, weight: face.weight,
        stretch: face.stretch, status: face.status });
    });
    fontFaces.sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const inkText = record.runs?.length ? record.runs.map((run) => run.text).join("") : record.text;
    return { font, fontReady: document.fonts?.check(font, inkText) ?? false,
      fontSetStatus: document.fonts?.status ?? null, fontAsset, fontFaces };
  };
  const fontMismatchSide = (info: Omit<CorpusInput, "record">, record: PixiTextRecord): FontMismatchSide => {
    const normalize = (value: string) => value.trim().replace(/^["']+|["']+$/g, "").toLowerCase();
    const normalizeWeight = (value: string) => {
      const weight = normalize(value);
      return weight === "normal" ? "400" : weight === "bold" ? "700" : weight;
    };
    const style = record.style as PixiTextRecord["style"] & Record<string, unknown>;
    const family = normalize(info.fontAsset?.family ?? String(style.fontFamily ?? "sans-serif"));
    const weight = normalizeWeight(info.fontAsset?.weight ?? String(style.fontWeight ?? "normal"));
    const faceStyle = normalize(info.fontAsset?.style ?? String(style.fontStyle ?? "normal"));
    const stretch = normalize(String(style.fontStretch ?? "normal"));
    return { font: info.font, fontReady: info.fontReady, fontSetStatus: info.fontSetStatus,
      fontAsset: info.fontAsset,
      matchingFaces: info.fontFaces.filter((face) => normalize(face.family) === family &&
        normalizeWeight(face.weight) === weight && normalize(face.style) === faceStyle &&
        normalize(face.stretch) === stretch) };
  };
  const fixtureBytes = (kind: "scene" | "resources"): Uint8Array | null => {
    if (kind === "scene") return committedScene;
    if (!fixtureEnabled || committedRevision === null) return null;
    if (!committedResourceBuffer) committedResourceBuffer = serializer.encodeRustResources(committedResources);
    return committedResourceBuffer;
  };
  // A fixture download spans many CDP calls. Pin one completed presentation for the whole
  // transfer so real-clock animation cannot switch the backing bytes between chunks.
  let fixtureSnapshot: { revision: number; scene: Uint8Array; resources: Uint8Array; rows: { key: string; width: number; height: number }[] } | null = null;
  if (fixtureEnabled) {
    globals.__mirrorRustFixture = () => {
      const scene = fixtureBytes("scene"), resources = fixtureBytes("resources");
      if (!scene || !resources || committedRevision === null) return null;
      fixtureSnapshot = { revision: committedRevision, scene, resources,
        rows: committedResources.map(({ key, width, height }) => ({ key, width, height })) };
      return { schema: "rust-scene-excerpt/1", revision: fixtureSnapshot.revision, backend: backendName,
        sceneBytes: scene.byteLength, resourcesBytes: resources.byteLength, resources: fixtureSnapshot.rows };
    };
    globals.__mirrorRustFixtureChunk = (kind, offset, length) => {
      const snapshot = fixtureSnapshot;
      const bytes = snapshot && (kind === "scene" ? snapshot.scene : snapshot.resources);
      if (!snapshot || !bytes || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset >= bytes.byteLength) return null;
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + Math.min(length, 1024 * 1024)));
      return { revision: snapshot.revision, offset, total: bytes.byteLength, base64: toBase64(chunk) };
    };
  }
  const statsEnabled = new URLSearchParams(window.location.search).get("rustDiagnostics") === "1" || rustDebug || textInkDiagnostics || textInkCorpus;
  const phaseTimingEnabled = new URLSearchParams(window.location.search).get("rustPhaseTiming") === "1";
  if (statsEnabled) globals.__mirrorRustStats = () => ({
    backend: backendName, wasmImportMs: importedAt - startedAt, wasmCompileMs: compiledAt - importedAt,
    surfaceCreateMs: createdAt - compiledAt, elapsedMs: performance.now() - startedAt,
    firstCompletedPresentMs: firstPresentMs, wasmMemoryBytes: wasmExports.memory?.buffer.byteLength ?? null,
    uploadCalls: wasmUploadCalls, sceneAdmissions: wasmAdmissionCalls, scenePatches: wasmPatchCalls, presentCalls: wasmPresentCalls,
    jsToWasmCalls: wasmUploadCalls + wasmAdmissionCalls + wasmPatchCalls + wasmPresentCalls + wasmResizeCalls,
    uploadBytes: wasmUploadBytes, sceneBytes: wasmSceneBytes, patchBytes: wasmPatchBytes,
    omittedCommands: unsupportedCommands, omittedKinds: { ...omittedKinds },
    jsToWasmBytes: wasmBytesSent,
    rustDrawCalls, rustBufferCreations, rustTextureCreations,
    rustAllocations: rustBufferCreations === null || rustTextureCreations === null ? null : rustBufferCreations + rustTextureCreations,
    rustUploadBytes, rustCompletedPresents, rustWasmCalls, rustInstanceUploadBytes, rustIncrementalPatches, rustGeometryRebuilds, rustMaxSampledTextures,
    rustDamagePresent: damagePresent, rustDamage: rustDamageStats && { ...rustDamageStats, last: rustLastDamage },
    rustPresentMode: rustLastPresentMode ?? appliedPresentMode,
    rustBlitPixels: { total: rustBlitPixelsTotal, last: rustLastBlitPixels },
    retainedPatchEncodes, retainedPatchEncodeMs, retainedPatchQueueWaitMs, retainedPatchPresentWaitMs,
    textPatchCommits, textPatchResourceChanges,
    ...(phaseTimingEnabled ? { retainedPatchApplyMs, sceneEncodeMs, sceneDiffMs, scenePatchApplyMs } : {}),
    committedRevision, committedSceneBytes: committedScene?.byteLength ?? 0,
    zeroCopyPixels,
    textRasterizations: stats.textRasterizations,
    textEvictions, textCacheResources: bitmap.stats().resources,
    msdf: msdfRuntime ? { glyphRunsEncoded: msdfGlyphRunsEncoded,
      glyphRunPresentations: msdfGlyphRunPresentations, glyphRunsLastPresented: msdfGlyphRunsLastPresented,
      fallbackReasons: { ...msdfFallbackReasons },
      atlas: msdfAtlas.stats(), generator: msdfRuntime.stats(),
      gpuAtlasTextures: msdfAtlas.stats().pages,
      gpuAtlasBytes: msdfAtlas.stats().bytes } : null,
    textInkReadFrequently,
    ...(textInkCorpus ? { textInkCorpus: true, textInkCorpusCount: corpusRows.length,
      textInkCorpusBytes: corpusBytes, textInkCorpusOverflow: corpusOverflow, textInkCorpusSealed: corpusSealed,
      textInkCorpusPrepared: capturePreparation?.accepted ?? false,
      textInkCorpusUnresolved: capturePreparation?.unresolved ?? null } : {}),
    ...(textInkDiagnostics ? { textInkDiagnosticEvents: textInkDiagnosticEvents.map((row) => ({ ...row })),
      textInkTimeOrigin: performance.timeOrigin,
      textInkDocumentNonce: (window as unknown as { __benchDocumentNonce?: string }).__benchDocumentNonce ?? null,
      textInkRendererInstance: startupRendererInstance ?? null,
      textInkDiagnosticEventLimit, textInkDiagnosticOverflow,
      textInkLastMissSubmission: textInkLastMissSubmission && {
      revision: textInkLastMissSubmission.revision, sceneRevision: textInkLastMissSubmission.sceneRevision,
      cacheMisses: textInkLastMissSubmission.cacheMisses,
      rasterCount: textInkLastMissSubmission.rasters.length,
      rasterBytes: textInkLastMissSubmission.rasters.reduce((bytes, row) => bytes + row.rgbaBytes, 0),
      readbackMs: textInkLastMissSubmission.rasters.reduce((ms, row) => ms + row.readbackMs, 0),
      rasters: textInkLastMissSubmission.rasters.map((row) => ({ ...row })),
    } } : {}),
    committedResourceBytes: committedResourceByteLength,
    pendingResources: [...pendingDetails].map(([key, value]) => ({ key, ...value, elapsedMs: performance.now() - value.startedAt })),
    resourceFailures: [...failures].map(([key, reason]) => ({ key, reason })),
    rustFast: { ...fast }, styleCacheHits, styleCacheMisses, prefetchSkips,
  });
  if (new URLSearchParams(window.location.search).get("rustDiagnostics") === "1") {
    globals.__mirrorRustRollbackProbe = async () => {
      const operation = submissionTail.then(async () => {
        const committed = committedTypedScene;
        if (!committed || committedRevision === null) return { available: false, reason: "no committed scene" };
        const stale = new TextEncoder().encode(JSON.stringify({ version: 1,
          baseRevision: committed.revision + 10_001, revision: committed.revision + 10_002, updates: [] }));
        const admission = parse<{ accepted: boolean; error?: string }>(engine.apply_patch(stale));
        wasmPatchCalls++; wasmPatchBytes += stale.byteLength; wasmBytesSent += stale.byteLength;
        if (admission.accepted) return { available: true, refused: false, reason: "stale patch unexpectedly accepted" };
        const resumed = await presentResult();
        return { available: true, refused: true, rejection: admission.error ?? "patch rejected",
          resumedPresented: resumed.presented, expectedRevision: committed.revision,
          observedRevision: lastRevision, committedRevision, retainedSceneBytes: committedScene?.byteLength ?? 0 };
      });
      submissionTail = operation.then(() => undefined, () => undefined);
      return operation;
    };
  }

  function readPixels(source: CanvasImageSource, resourceKey: string, naturalWidth: number, naturalHeight: number,
    textRaster?: TextInkRaster, useZeroCopy = zeroCopyPixels, emitResourceEvent = true): ResourcePixels {
    const cardAtlas = startupEvent !== null && isCardAtlas(resourceKey);
    const conversionAt = textRaster ? performance.now() : 0;
    const scratch = canvas.ownerDocument.createElement("canvas");
    scratch.width = naturalWidth; scratch.height = naturalHeight;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(`2D context unavailable for ${resourceKey}`);
    if (textRaster) textRaster.scratchContextAttributes = context.getContextAttributes?.() ?? null;
    const drawAt = cardAtlas ? performance.now() : 0;
    const scratchDrawAt = textRaster ? performance.now() : 0;
    context.clearRect(0, 0, naturalWidth, naturalHeight);
    context.drawImage(source, 0, 0, naturalWidth, naturalHeight);
    if (textRaster) textRaster.scratchDrawMs = performance.now() - scratchDrawAt;
    const drawnAt = cardAtlas ? performance.now() : 0;
    const imageDataAt = textRaster ? performance.now() : 0;
    const imageData = context.getImageData(0, 0, naturalWidth, naturalHeight).data;
    if (textRaster) textRaster.getImageDataMs = performance.now() - imageDataAt;
    const readAt = cardAtlas ? performance.now() : 0;
    const pixelViewAt = textRaster ? performance.now() : 0;
    // The typed view retains ImageData's buffer after the scratch canvas and
    // decoded bitmap are released. Resource serialization reads it before the
    // synchronous WASM upload; neither path transfers or detaches this buffer.
    const pixels = useZeroCopy
      ? new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength)
      : new Uint8Array(imageData);
    if (textRaster) {
      textRaster.pixelViewMs = performance.now() - pixelViewAt;
      textRaster.scratchConversionMs = performance.now() - conversionAt;
      textRaster.readbackMs = textRaster.scratchConversionMs;
    }
    if (cardAtlas) startupEvent!("cardAtlas.pixelReadback", { key: resourceKey,
      width: naturalWidth, height: naturalHeight, rgbaBytes: pixels.byteLength,
      drawMs: drawnAt - drawAt, getImageDataMs: readAt - drawnAt,
      uint8CopyMs: performance.now() - readAt });
    if (emitResourceEvent) startupResourceEvent?.("pixels", { key: resourceKey, width: naturalWidth, height: naturalHeight,
      rgbaBytes: pixels.byteLength, copy: useZeroCopy ? "view" : "copy" });
    return { key: resourceKey, width: naturalWidth, height: naturalHeight, pixels };
  }

  function cacheCanvasTexture(key: string, source: HTMLCanvasElement): void {
    try {
      const next = readPixels(source, key, source.width, source.height);
      textures.set(key, next); uploaded.delete(key); stats.textures = textures.size; onInvalidate("resource");
    } catch (error) { failures.set(key, error instanceof Error ? error.message : String(error)); stats.textureFailures = failures.size; }
  }

  function prefetch(texture: string): void {
    if (textures.has(texture) || pending.has(texture) || failures.has(texture) || disposed) return;
    const cardAtlas = startupEvent !== null && isCardAtlas(texture);
    const fetchAt = cardAtlas ? performance.now() : 0;
    const detail: { phase: "fetch" | "body" | "decode" | "readPixels"; startedAt: number; status?: number; bytes?: number } =
      { phase: "fetch", startedAt: performance.now() };
    pendingDetails.set(texture, detail);
    if (cardAtlas) startupEvent!("cardAtlas.fetchStart", { key: texture });
    startupEvent?.("texture.fetchStart", { key: texture, pending: pending.size + 1,
      failed: failures.size });
    const task = (async () => {
      try {
        const response = await fetch(texture, { credentials: "same-origin" });
        if (cardAtlas) startupEvent!("cardAtlas.response", { key: texture,
          waitMs: performance.now() - fetchAt, status: response.status });
        startupEvent?.("texture.fetchResponse", { key: texture, status: response.status,
          pending: pending.size, failed: failures.size });
        detail.status = response.status;
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        detail.phase = "body";
        const bodyAt = cardAtlas ? performance.now() : 0;
        const blob = await response.blob();
        if (cardAtlas) startupEvent!("cardAtlas.body", { key: texture,
          waitMs: performance.now() - bodyAt, encodedBytes: blob.size });
        startupEvent?.("texture.bodyReady", { key: texture, bytes: blob.size,
          pending: pending.size, failed: failures.size });
        detail.bytes = blob.size;
        startupResourceEvent?.("body", { key: texture, encodedBytes: blob.size });
        detail.phase = "decode";
        startupEvent?.("texture.decodeStart", { key: texture,
          pending: pending.size, failed: failures.size });
        const decodeAt = cardAtlas ? performance.now() : 0;
        const bitmapPromise = createImageBitmap(blob);
        const decodeReturnedAt = cardAtlas ? performance.now() : 0;
        const bitmap = await bitmapPromise;
        startupResourceEvent?.("decoded", { key: texture, width: bitmap.width, height: bitmap.height });
        if (cardAtlas) startupEvent!("cardAtlas.bitmapDecoded", { key: texture,
          syncCallMs: decodeReturnedAt - decodeAt, awaitMs: performance.now() - decodeReturnedAt,
          width: bitmap.width, height: bitmap.height, encodedBytes: blob.size });
        startupEvent?.("texture.decoded", { key: texture, width: bitmap.width,
          height: bitmap.height, pending: pending.size, failed: failures.size });
        detail.phase = "readPixels";
        startupEvent?.("texture.readPixelsStart", { key: texture,
          pending: pending.size, failed: failures.size });
        const pixels = readPixels(bitmap, texture, bitmap.width, bitmap.height);
        bitmap.close(); textures.set(texture, pixels); stats.textures = textures.size;
        startupEvent?.("texture.pixelsReady", { key: texture, bytes: pixels.pixels.byteLength,
          pending: pending.size, failed: failures.size });
      } catch (error) {
        failures.set(texture, error instanceof Error ? error.message : String(error));
        stats.textureFailures = failures.size;
        startupEvent?.("texture.failed", { key: texture,
          reason: failures.get(texture) ?? null, pending: pending.size, failed: failures.size });
      } finally {
        pending.delete(texture); pendingDetails.delete(texture); stats.resourcePending = pending.size;
        startupEvent?.("texture.settled", { key: texture,
          pending: pending.size, failed: failures.size });
        onInvalidate("resource");
      }
    })();
    pending.set(texture, task); stats.resourcePending = pending.size; stats.textureLoads++;
  }

  // rustFast `textPrepCache`: `record.style` is the SAME object reference across builds only when the renderer's
  // own text-prep cache is also on (see rustTextPreparation.ts's `PreparedTextRun.style`) — with the renderer's
  // cache off this WeakMap simply never hits and costs one extra `.get`/`.set` per call, which is why this half
  // is keyed off the identical `fast.textPrepCache` switch rather than a switch of its own.
  const styleJson = (style: PixiTextRecord["style"]): string => {
    if (!fast.textPrepCache) return JSON.stringify(style);
    const cached = styleStringCache.get(style);
    if (cached !== undefined) { styleCacheHits++; return cached; }
    styleCacheMisses++;
    const json = JSON.stringify(style);
    styleStringCache.set(style, json);
    return json;
  };
  const textResourceKey = (record: PixiTextRecord) => {
    const revision = record.resourceRevision ?? record.contentKey ?? "";
    return `text:${record.key}:${revision}:${record.text}:${styleJson(record.style)}:${record.tint ?? 0xffffff}`;
  };
  const bitmap = createBitmapTextMethod({
    canvas, textResourceKey, readPixels,
    get textInkDiagnostics() { return textInkDiagnostics; },
    get textInkCurrentSubmission() { return textInkCurrentSubmission; },
    textInkDiagnosticEvents, textInkDiagnosticEventLimit,
    setDiagnosticOverflow: () => { textInkDiagnosticOverflow = true; },
    setLastMissSubmission: (value) => { textInkLastMissSubmission = value; },
    onRasterization: () => { stats.textRasterizations++; }
  });
  // rustTextEvict: `encodeRustResourceUpdates` rejects a batch over 4096 entries; stay well under that even
  // though a commit this round only ever overflows the pool by a handful of keys (closing a large,
  // ~300-label screen is the realistic ceiling, around 200 — see the ledger row).
  const RELEASE_BATCH_CHUNK_SIZE = 1024;
  /** rustTextEvict: release these Bitmap keys from every place they are resident — the JS cache, the
   *  executor's own upload bookkeeping, and the Rust GPU texture — via the same RSR2 `release` operation
   *  `textMethods/msdfAtlas.ts` uses for atlas pages. */
  function releaseTextResources(keys: readonly string[]): void {
    if (!keys.length) return;
    bitmap.evict(keys);
    for (const key of keys) { uploaded.delete(key); uploadedPixels.delete(key); }
    textEvictions += keys.length;
    for (let offset = 0; offset < keys.length; offset += RELEASE_BATCH_CHUNK_SIZE) {
      const chunk = keys.slice(offset, offset + RELEASE_BATCH_CHUNK_SIZE);
      try {
        const batch = serializer.encodeRustResourceUpdates(chunk.map((key): RustResourceUpdate => ({ operation: "release", key })));
        engine.upload_rgba_batch(batch);
        wasmUploadCalls++; wasmUploadBytes += batch.byteLength; wasmBytesSent += batch.byteLength;
      } catch (error) {
        // The key is already gone from every JS-side place a later build could find it (above, before this
        // loop even starts), so a failed release only leaks Rust-side GPU memory for these keys — it must
        // never throw back into `submit()`'s continuation and turn an already-presented frame into a
        // rejected promise (mirrors MSDF's own `upload` try/catch in `textMethods/msdfAtlas.ts`).
        logRust("rustTextEvict release failed", error);
      }
    }
  }
  /**
   * rustTextEvict: called after a full build actually commits, and after a `rustTextPatch` patch that changed the
   * resource list commits (its new keys are pinned in `inFlightTextKeys` while it is in flight, like a build's). `resources` is that same commit's `encoded.resources`, so a key still
   * referenced by the just-committed scene is protected by construction, and so is a key a later retained
   * patch could diff against — its base IS this same committed scene.
   *
   * A key an ENCODED-BUT-NOT-YET-SETTLED sibling `submit()` call needs is also protected, via
   * `inFlightTextKeys` — the caller above this executor is expected to serialize builds/patches
   * (`asyncSubmissionRevision`), but that is the CALLER's invariant, not this executor's; a second `submit()`
   * can still run its own synchronous encode (and its own upload-skip decision keyed on `uploaded.has`)
   * before this commit's eviction runs, so eviction defends itself rather than trusting the caller.
   */
  function evictUnreferencedText(resources: readonly { key: string }[]): void {
    const referenced: string[] = [];
    for (const resource of resources) if (resource.key.startsWith("text:")) referenced.push(resource.key);
    for (const key of inFlightTextKeys.keys()) referenced.push(key);
    const evicted = textEvictionTracker.commit(referenced, bitmap.cachedKeys());
    if (evicted.length) releaseTextResources(evicted);
  }
  type InlineImageRecord = PixiTextRecord & { inlineImage?: { url: string; width: number; height: number } };
  function rasterText(record: PixiTextRecord): { resource: { key: string; width: number; height: number }; pixels: Uint8Array; width: number; height: number; transform: readonly number[]; alpha?: number } | null {
    const inline = (record as InlineImageRecord).inlineImage;
    if (inline) {
      const pixels = textures.get(inline.url);
      return pixels ? { resource: { key: pixels.key, width: pixels.width, height: pixels.height },
        pixels: pixels.pixels, width: inline.width, height: inline.height,
        transform: record.localTransform ?? record.transform, alpha: record.alpha } : null;
    }
    let row: CorpusRow | null = null;
    if (textInkCorpus && !corpusSealed && !bitmap.hasCached(textResourceKey(record))) {
      if (corpusRows.length >= corpusLimit) { corpusOverflow = true; throw new Error(`Rust text corpus limit exceeded (${corpusLimit})`); }
      const input = { record: JSON.parse(canonical(record)) as PixiTextRecord, ...fontInfo(record) };
      corpusBytes += textBytes(canonical(input)).byteLength;
      if (corpusBytes > corpusByteLimit) { corpusOverflow = true; throw new Error("Rust text corpus byte limit exceeded"); }
      row = { input, measurements: null, diagnostic: null, width: null, height: null, rgba: null };
      corpusRows.push(row);
    }
    const result = bitmap.prepare(record, { inkReadFrequently: textInkReadFrequently, zeroCopyPixels, corpusRow: row ?? undefined });
    if (row && result) {
      row.diagnostic = textInkDiagnosticEvents.at(-1) ?? null;
      row.width = result.width; row.height = result.height;
      row.rgba = new Uint8Array(result.pixels);
      corpusBytes += row.rgba.byteLength;
      if (corpusBytes > corpusByteLimit) { corpusOverflow = true; throw new Error("Rust text corpus byte limit exceeded"); }
    }
    return result;
  }

  /**
   * Which labels (node ids, at most 256) fell back from MSDF to a Bitmap raster, and why. Diagnostic only: kept only
   * under `rustDiagnostics=1` (or the other stats modes).
   */
  const msdfFallbackLabels: Record<string, number> = {};
  let msdfFallbackLabelCount = 0;
  function noteMsdfFallbackLabel(reason: string, record: PixiTextRecord): void {
    if (!statsEnabled) return;
    const key = `${reason}:${record.labelId ?? record.key}`;
    if (key in msdfFallbackLabels) msdfFallbackLabels[key]++;
    else if (msdfFallbackLabelCount < 256) { msdfFallbackLabels[key] = 1; msdfFallbackLabelCount++; }
  }
  function resolveText(record: PixiTextRecord): RustTextCarrier | null {
    if (msdfRuntime && !(record as InlineImageRecord).inlineImage) {
      const shaped = msdfRuntime.shape(record as MsdfRunRecord);
      if ("run" in shaped) {
        const placements = new Map<number, NonNullable<ReturnType<MsdfAtlas["placement"]>>>();
        const missing: number[] = [];
        let failed: string | undefined;
        for (const glyph of shaped.run.glyphs) {
          const key = msdfGlyphKey(shaped.face.url, shaped.run.range, glyph.glyphId);
          const placement = msdfAtlas.placement(key);
          if (placement) placements.set(glyph.glyphId, placement);
          else if (!failed) {
            failed = msdfAtlas.failure(key) ?? msdfRuntime.failureFor(key);
            if (!failed) missing.push(glyph.glyphId);
          }
        }
        if (!failed && !missing.length) {
          const carrier = carrierForMsdfRun(record as MsdfRunRecord, shaped.run, placements);
          if (carrier) { msdfGlyphRunsEncoded++; return carrier; }
          failed = "carrier";
        } else if (!failed) {
          msdfRuntime.request(shaped.face, shaped.run.range, missing);
          failed = "glyph-pending";
        }
        msdfFallbackReasons[failed] = (msdfFallbackReasons[failed] ?? 0) + 1;
        noteMsdfFallbackLabel(failed, record);
      } else {
        msdfFallbackReasons[shaped.reason] = (msdfFallbackReasons[shaped.reason] ?? 0) + 1;
        noteMsdfFallbackLabel(shaped.reason, record);
      }
    }
    return rasterText(record);
  }


  if (textInkCorpus) {
    const metadata = async (rows: CorpusRow[]) => Promise.all(rows.map(async (row) => {
      if (!row.rgba || row.width === null || row.height === null || !row.measurements || !row.diagnostic)
        throw new Error("Rust text corpus has an incomplete raster");
      return { input: row.input, inputSha256: await sha256(textBytes(canonical(row.input))),
        measurements: row.measurements, diagnostic: { ...row.diagnostic },
        width: row.width, height: row.height, rgbaBytes: row.rgba.byteLength,
        rgbaSha256: await sha256(row.rgba) };
    }));
    type CorpusMetadata = Awaited<ReturnType<typeof metadata>>;
    type CorpusV2 = { schema: "rust-text-corpus/2"; id: string; rows: CorpusMetadata;
      preparedRows: CorpusMetadata; preparedFontManifest: FontPreparation;
      productionCssBeforePreparation: typeof productionCssBeforePreparation };
    const corpusId = async (rows: CorpusMetadata, preparedRows: CorpusMetadata,
      manifest: FontPreparation, cssBefore: typeof productionCssBeforePreparation) =>
      sha256(textBytes(canonical({ rows, preparedRows, preparedFontManifest: manifest,
        productionCssBeforePreparation: cssBefore })));
    const selectedLoaded = (side: FontMismatchSide) => side.matchingFaces.filter((face) => face.status === "loaded");
    const sourceRowsOf = async (value: unknown): Promise<CorpusV2> => {
      if (!value || typeof value !== "object") throw new Error("Invalid Rust text corpus");
      const corpus = value as CorpusV2;
      if (corpus.schema !== "rust-text-corpus/2" || !corpus.id || !Array.isArray(corpus.rows) ||
          !Array.isArray(corpus.preparedRows) || !corpus.preparedFontManifest?.accepted ||
          !Array.isArray(corpus.preparedFontManifest.rows) ||
          !Array.isArray(corpus.preparedFontManifest.assets) ||
          !corpus.rows.length || corpus.rows.length !== corpus.preparedRows.length ||
          corpus.rows.length !== corpus.preparedFontManifest.rows.length || corpus.rows.length > corpusLimit ||
          await corpusId(corpus.rows, corpus.preparedRows, corpus.preparedFontManifest,
            corpus.productionCssBeforePreparation) !== corpus.id)
        throw new Error("Rust text corpus identity mismatch");
      for (const [index, row] of corpus.rows.entries()) {
        if (await sha256(textBytes(canonical(row.input))) !== row.inputSha256)
          throw new Error("Rust text corpus input changed");
        if (canonical(corpus.preparedRows[index].input) !== canonical(row.input) ||
            corpus.preparedFontManifest.rows[index].index !== index ||
            corpus.preparedFontManifest.rows[index].recordKey !== row.input.record.key)
          throw new Error(`Rust text corpus row order or prepared input changed: ${index}`);
        const derived = fontInfo(row.input.record);
        if (row.input.font !== derived.font ||
            canonical(row.input.fontAsset) !== canonical(derived.fontAsset) ||
            !corpus.preparedFontManifest.assets.some((asset) =>
              asset.url === row.input.fontAsset?.url && asset.family === row.input.fontAsset.family))
          throw new Error(`Rust text corpus font descriptor or asset identity changed: ${row.input.record.key}`);
      }
      return corpus;
    };
    globals.__mirrorRustTextCorpus = {
      lastFontMismatch: () => lastFontMismatch && JSON.parse(canonical(lastFontMismatch)) as FontMismatchEvidence,
      async prepareFonts(value) {
        const imported = value === undefined ? null : await sourceRowsOf(value);
        if (!imported) {
          if (corpusOverflow || !corpusRows.length) throw new Error("Rust text corpus empty or overflowed");
          corpusSealed = true;
        }
        const sourceRows = imported?.rows ?? await metadata(corpusRows);
        const families = new Map<string, NonNullable<CorpusInput["fontAsset"]>>();
        const assetFailures = new Map<string, string>();
        for (const row of sourceRows) {
          const asset = row.input.fontAsset;
          if (!asset?.family || !asset.url) { assetFailures.set(row.input.record.key, "missing font asset"); continue; }
          const prior = families.get(asset.family);
          if (prior && prior.url !== asset.url) assetFailures.set(asset.family, "ambiguous family URLs");
          else families.set(asset.family, asset);
        }
        if (!imported) productionCssBeforePreparation = [...families].map(([family]) =>
          ({ family, registration: mirrorFontRegistration(family) }));
        const assets: PreparedFontAsset[] = [];
        for (const [family, asset] of families) {
          if (assetFailures.has(family)) continue;
          const expected = imported?.preparedFontManifest.assets.find((row) => row.family === family);
          if (imported && (!expected || expected.url !== asset.url)) {
            assetFailures.set(family, "manifest asset URL missing or changed"); continue;
          }
          const requested = expected?.registered ?? { weight: asset.weight, style: asset.style };
          ensureFontFace(family, asset.url, requested.weight, requested.style);
          const registered = mirrorFontRegistration(family);
          if (!registered || registered.url !== asset.url ||
              registered.attempts.some((attempt) => attempt.url !== asset.url) ||
              !document.querySelector('style[data-mirror-fonts]')?.textContent?.includes(registered.cssRule) ||
              (expected && canonical(expected.registered) !== canonical({ url: registered.url,
                weight: registered.weight, style: registered.style, cssRule: registered.cssRule }))) {
            assetFailures.set(family, "font registration association missing or ambiguous"); continue;
          }
          try {
            const absolute = new URL(asset.url, window.location.href);
            if (absolute.origin !== window.location.origin) throw new Error("cross-origin font asset");
            const response = await fetch(absolute.href, { credentials: "same-origin" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const hash = await sha256(bytes);
            if (expected && (expected.sha256 !== hash || expected.bytes !== bytes.byteLength))
              throw new Error("font asset bytes changed");
            assets.push({ family, url: asset.url, weight: asset.weight, style: asset.style,
              sha256: hash, bytes: bytes.byteLength,
              registered: { url: registered.url, weight: registered.weight,
                style: registered.style, cssRule: registered.cssRule } });
          } catch (error) {
            assetFailures.set(family, error instanceof Error ? error.message : String(error));
          }
        }
        const rows: FontPreparation["rows"] = [];
        for (const [index, row] of sourceRows.entries()) {
          const input = row.input;
          const asset = input.fontAsset;
          let reason = assetFailures.get(asset?.family ?? input.record.key) ?? null;
          let loadedFaces: FontFace[] = [];
          if (!reason && asset) {
            const inkText = input.record.runs?.length
              ? input.record.runs.map((run) => run.text).join("") : input.record.text;
            try {
              loadedFaces = await loadMirrorFont(document.fonts, input.font, inkText, asset.family);
              await document.fonts.ready;
            } catch (error) { reason = error instanceof Error ? error.message : String(error); }
          }
          const observed = fontInfo(input.record);
          const expectedSide = fontMismatchSide(input, input.record);
          const observedSide = fontMismatchSide(observed, input.record);
          const selectedReturned = fontMismatchSide({ ...observed,
            fontFaces: loadedFaces.map((face) => ({ family: face.family, weight: face.weight,
              style: face.style, stretch: face.stretch, status: face.status })) }, input.record);
          if (!reason && (!observed.fontReady || !asset ||
              canonical({ font: input.font, fontAsset: asset }) !==
                canonical({ font: observed.font, fontAsset: observed.fontAsset }) ||
              selectedLoaded(observedSide).length !== 1 ||
              selectedLoaded(selectedReturned).length !== 1)) reason = "selected font face unavailable or ambiguous";
          rows.push({ index, recordKey: input.record.key, expected: expectedSide,
            observed: observedSide, registered: asset ? mirrorFontRegistration(asset.family) : null, reason });
        }
        const receipt: FontPreparation = { accepted: rows.every((row) => row.reason === null),
          assets, rows, unresolved: rows.filter((row) => row.reason !== null).map((row) => row.index) };
        if (imported) importedPreparation = { corpusId: imported.id, receipt };
        else {
          capturePreparation = receipt;
          preparedBaseline = null;
          if (receipt.accepted) {
            preparedBaseline = [];
            let preparedBytes = 0;
            for (const row of corpusRows) {
              const events: TextInkRaster[] = [];
              const prepared: CorpusRow = { input: row.input, measurements: null, diagnostic: null,
                width: null, height: null, rgba: null };
              const result = bitmap.prepare(row.input.record, { inkReadFrequently: false, zeroCopyPixels: false, replayEvents: events, freshCache: true, corpusRow: prepared });
              if (!result) throw new Error(`Prepared Rust text raster refused: ${row.input.record.key}`);
              preparedBytes += result.pixels.byteLength;
              if (preparedBytes > corpusByteLimit) throw new Error("Prepared Rust text corpus byte limit exceeded");
              preparedBaseline.push({ ...prepared, width: result.width, height: result.height,
                rgba: new Uint8Array(result.pixels), diagnostic: events[0] ?? null });
            }
          }
        }
        return JSON.parse(canonical(receipt)) as FontPreparation;
      },
      async snapshot() {
        pinnedCorpus = null;
        pinnedPrepared = null;
        if (corpusOverflow) throw new Error("Rust text corpus overflowed");
        corpusSealed = true;
        if (!corpusRows.length) throw new Error("Rust text corpus is empty");
        if (!capturePreparation?.accepted || !preparedBaseline || !productionCssBeforePreparation)
          throw new Error("Rust text corpus fonts have not been prepared for every row");
        const rows = await metadata(corpusRows);
        const preparedRows = await metadata(preparedBaseline);
        const id = await corpusId(rows, preparedRows, capturePreparation, productionCssBeforePreparation);
        pinnedCorpus = { id, rows: corpusRows.map((row) => ({ ...row, rgba: new Uint8Array(row.rgba!) })) };
        pinnedPrepared = { id, rows: preparedBaseline.map((row) => ({ ...row, rgba: new Uint8Array(row.rgba!) })) };
        return { schema: "rust-text-corpus/2", id, count: rows.length, bytes: corpusBytes,
          rows: JSON.parse(canonical(rows)) as typeof rows,
          preparedRows: JSON.parse(canonical(preparedRows)) as typeof preparedRows,
          preparedFontManifest: JSON.parse(canonical(capturePreparation)) as FontPreparation,
          productionCssBeforePreparation: JSON.parse(canonical(productionCssBeforePreparation)) as typeof productionCssBeforePreparation };
      },
      async replay(value, inkReadFrequently) {
        pinnedReplay = null;
        lastFontMismatch = null;
        if (zeroCopyPixels) throw new Error("Rust text corpus replay requires rustZeroCopyPixels OFF");
        const corpus = await sourceRowsOf(value);
        if (!((importedPreparation?.corpusId === corpus.id && importedPreparation.receipt.accepted) ||
              (pinnedCorpus?.id === corpus.id && capturePreparation?.accepted)))
          throw new Error("Rust text corpus imported fonts have not been prepared");
        await document.fonts.ready;
        const replayRows: CorpusRow[] = [];
        let replayBytes = 0;
        for (const [rowIndex, row] of corpus.rows.entries()) {
          if (await sha256(textBytes(canonical(row.input))) !== row.inputSha256) throw new Error("Rust text corpus input changed");
          const expected = row.input;
          const preparedExpected = corpus.preparedFontManifest.rows[rowIndex]?.observed;
          const actualFont = fontInfo(expected.record);
          if (!preparedExpected) throw new Error(`Rust text corpus prepared font receipt missing: ${rowIndex}`);
          const expectedSelected = preparedExpected;
          const actualSelected = fontMismatchSide(actualFont, expected.record);
          const checks = {
            ready: expectedSelected.fontReady && actualFont.fontReady,
            asset: Boolean(expectedSelected.fontAsset && actualFont.fontAsset),
            descriptorAndFaceSet: canonical({ font: expectedSelected.font, fontAsset: expectedSelected.fontAsset,
              loadedFaces: expectedSelected.matchingFaces.filter((face) => face.status === "loaded") }) ===
              canonical({ font: actualFont.font, fontAsset: actualFont.fontAsset,
                loadedFaces: actualSelected.matchingFaces.filter((face) => face.status === "loaded") }),
          };
          if (!checks.ready || !checks.asset || !expectedSelected.matchingFaces.some((face) => face.status === "loaded") ||
              !actualSelected.matchingFaces.some((face) => face.status === "loaded") || !checks.descriptorAndFaceSet) {
            lastFontMismatch = { rowIndex, recordKey: expected.record.key,
              expected: expectedSelected, actual: actualSelected, checks };
            throw new Error(`Rust text corpus font unavailable: ${canonical(lastFontMismatch)}`);
          }
          const events: TextInkRaster[] = [];
          const replayRow: CorpusRow = { input: expected, measurements: null, diagnostic: null,
            width: null, height: null, rgba: null };
          // Every corpus row is a production cache miss, including a key rasterized again after invalidation.
          const result = bitmap.prepare(expected.record, { inkReadFrequently: inkReadFrequently, zeroCopyPixels: false, replayEvents: events, freshCache: true, corpusRow: replayRow });
          if (!result) throw new Error(`Rust text corpus raster refused: ${expected.record.key}`);
          const preparedRow = corpus.preparedRows[rowIndex];
          if (canonical(replayRow.measurements) !== canonical(preparedRow.measurements))
            throw new Error(`Rust text corpus font metrics changed: ${expected.record.key}`);
          const rgba = new Uint8Array(result.pixels);
          const rgbaSha256 = await sha256(rgba);
          if (result.width !== preparedRow.width || result.height !== preparedRow.height ||
              rgba.byteLength !== preparedRow.rgbaBytes || rgbaSha256 !== preparedRow.rgbaSha256)
            throw new Error(`Rust text corpus pixels changed: ${canonical({ rowIndex, recordKey: expected.record.key,
              expected: { width: preparedRow.width, height: preparedRow.height,
                rgbaBytes: preparedRow.rgbaBytes, rgbaSha256: preparedRow.rgbaSha256 },
              actual: { width: result.width, height: result.height, rgbaBytes: rgba.byteLength, rgbaSha256 } })}`);
          replayBytes += rgba.byteLength;
          if (replayBytes > corpusByteLimit) throw new Error("Rust text corpus replay byte limit exceeded");
          replayRow.diagnostic = events[0] ?? null;
          replayRows.push({ ...replayRow, width: result.width, height: result.height, rgba });
        }
        const rows = await metadata(replayRows);
        const id = await sha256(textBytes(canonical(rows)));
        pinnedReplay = { id, rows: replayRows };
        return { schema: "rust-text-corpus-replay/2", sourceId: corpus.id, id,
          inkReadFrequently, zeroCopyPixels: false, count: rows.length, bytes: replayBytes,
          rows: JSON.parse(canonical(rows)) as typeof rows };
      },
      async replayPhone(value, inkReadFrequently) {
        pinnedPhoneReplay.delete(inkReadFrequently);
        lastFontMismatch = null;
        if (zeroCopyPixels) throw new Error("Rust text phone corpus replay requires rustZeroCopyPixels OFF");
        const corpus = await sourceRowsOf(value);
        const preparation = importedPreparation?.corpusId === corpus.id ? importedPreparation.receipt : null;
        if (!preparation?.accepted || preparation.rows.length !== corpus.rows.length)
          throw new Error("Rust text phone corpus imported fonts have not been prepared");
        await document.fonts.ready;
        const replayRows: CorpusRow[] = [];
        const observedFonts: FontMismatchSide[] = [];
        let replayBytes = 0;
        for (const [rowIndex, row] of corpus.rows.entries()) {
          const expected = row.input;
          const prepared = preparation.rows[rowIndex];
          const actualFont = fontInfo(expected.record);
          const actualSelected = fontMismatchSide(actualFont, expected.record);
          const selectedExpected = prepared?.observed;
          const asset = expected.fontAsset;
          const registered = asset && mirrorFontRegistration(asset.family);
          const checks = {
            ready: Boolean(actualFont.fontReady && selectedLoaded(actualSelected).length === 1),
            asset: Boolean(asset && preparation.assets.some((item) =>
              item.family === asset.family && item.url === asset.url &&
              corpus.preparedFontManifest.assets.some((source) => source.family === item.family &&
                source.url === item.url && source.sha256 === item.sha256 && source.bytes === item.bytes))),
            descriptorAndFaceSet: Boolean(prepared && !prepared.reason && selectedExpected && registered &&
              canonical({ font: expected.font, fontAsset: asset }) ===
                canonical({ font: actualFont.font, fontAsset: actualFont.fontAsset }) &&
              canonical(selectedLoaded(actualSelected)) === canonical(selectedLoaded(selectedExpected)) &&
              preparation.assets.some((item) => item.family === asset?.family &&
                canonical(item.registered) === canonical({ url: registered.url,
                  weight: registered.weight, style: registered.style, cssRule: registered.cssRule })) &&
              document.querySelector('style[data-mirror-fonts]')?.textContent?.includes(registered.cssRule)),
          };
          if (!checks.ready || !checks.asset || !checks.descriptorAndFaceSet) {
            lastFontMismatch = { rowIndex, recordKey: expected.record.key,
              expected: selectedExpected ?? fontMismatchSide(expected, expected.record),
              actual: actualSelected, checks };
            throw new Error(`Rust text phone corpus font unavailable: ${canonical(lastFontMismatch)}`);
          }
          const events: TextInkRaster[] = [];
          const replayRow: CorpusRow = { input: expected, measurements: null, diagnostic: null,
            width: null, height: null, rgba: null };
          const result = bitmap.prepare(expected.record, { inkReadFrequently, zeroCopyPixels: false, replayEvents: events, freshCache: true, corpusRow: replayRow });
          if (!result || events.length !== 1 || events[0].outcome !== "ready")
            throw new Error(`Rust text phone corpus raster refused: ${expected.record.key}`);
          const rgba = new Uint8Array(result.pixels);
          replayBytes += rgba.byteLength;
          if (replayBytes > corpusByteLimit) throw new Error("Rust text phone corpus replay byte limit exceeded");
          replayRows.push({ ...replayRow, width: result.width, height: result.height,
            rgba, diagnostic: events[0] });
          observedFonts.push(actualSelected);
        }
        const rows = await Promise.all(replayRows.map(async (row, index) => ({
          index, recordKey: row.input.record.key, inputSha256: corpus.rows[index].inputSha256,
          measurements: row.measurements, diagnostic: row.diagnostic, width: row.width, height: row.height,
          rgbaBytes: row.rgba!.byteLength, rgbaSha256: await sha256(row.rgba!),
          observedFont: observedFonts[index],
        })));
        const id = await sha256(textBytes(canonical({ sourceId: corpus.id, inkReadFrequently, rows })));
        pinnedPhoneReplay.set(inkReadFrequently, { id, rows: replayRows });
        return { schema: "rust-text-corpus-phone-replay/1", sourceId: corpus.id, id,
          inkReadFrequently, zeroCopyPixels: false, count: rows.length, bytes: replayBytes,
          assets: preparation.assets, rows: JSON.parse(canonical(rows)) as typeof rows };
      },
      chunk(kind, id, index, offset, length) {
        const pinned = kind === "capture" ? pinnedCorpus : kind === "prepared" ? pinnedPrepared
          : kind === "replay" ? pinnedReplay : kind === "phone-off" ? pinnedPhoneReplay.get(false)
            : kind === "phone-on" ? pinnedPhoneReplay.get(true) : null;
        const rgba = pinned?.rows[index]?.rgba;
        if (!pinned || pinned.id !== id || !rgba || !Number.isSafeInteger(index) || !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) || index < 0 || offset < 0 || offset >= rgba.byteLength || length < 1) return null;
        const bytes = rgba.subarray(offset, Math.min(rgba.byteLength, offset + Math.min(length, 64 * 1024)));
        return { id, index, offset, total: rgba.byteLength, base64: toBase64(bytes) };
      },
    };
  }

  async function presentResult(operationId?: number, identity?: ProfileIdentity): Promise<{ presented: boolean; reason?: string; revision?: number; draws?: number; completedFrames?: number }> {
    if (profile && identity) setProfileIdentity(identity);
    else if (executionPhases && operationId !== undefined) engine.set_phase_operation_id!(operationId);
    const result = parse<{ presented: boolean; revision?: number | null; draws: number; resourcePending: number; unsupportedCommands: number; error?: string;
      drawCalls?: number; bufferCreations?: number; textureCreations?: number; uploadBytes?: number; completedPresents?: number; wasmCalls?: number;
      instanceUploadBytes?: number; incrementalPatches?: number; geometryRebuilds?: number; maxSampledTextures?: number;
      damage?: string; damageStats?: RustDamageStats; present?: string; blitPixels?: number }>(await engine.present());
    wasmPresentCalls++;
    if (result.drawCalls !== undefined) rustDrawCalls = result.drawCalls;
    if (result.bufferCreations !== undefined) rustBufferCreations = result.bufferCreations;
    if (result.textureCreations !== undefined) rustTextureCreations = result.textureCreations;
    if (result.uploadBytes !== undefined) rustUploadBytes = result.uploadBytes;
    if (result.completedPresents !== undefined) rustCompletedPresents = result.completedPresents;
    if (result.wasmCalls !== undefined) rustWasmCalls = result.wasmCalls;
    if (result.instanceUploadBytes !== undefined) rustInstanceUploadBytes = result.instanceUploadBytes;
    if (result.incrementalPatches !== undefined) rustIncrementalPatches = result.incrementalPatches;
    if (result.geometryRebuilds !== undefined) rustGeometryRebuilds = result.geometryRebuilds;
    if (result.maxSampledTextures !== undefined) rustMaxSampledTextures = result.maxSampledTextures;
    rustDamageStats = result.damageStats ?? null;
    rustLastDamage = result.damage ?? null;
    // rustPresent: mirrors damage above — a present's own report of which mode ran and how many pixels its
    // blit moved, accumulated across the engine's lifetime (reset on context restore, in configureEngine).
    rustLastPresentMode = result.present ?? null;
    if (result.blitPixels !== undefined) { rustBlitPixelsTotal += result.blitPixels; rustLastBlitPixels = result.blitPixels; }
    stats.frames++; stats.resourcePending = result.resourcePending;
    if (result.presented) { stats.completedFrames++; presentationValid = true; stats.presentationValid = true; lastRevision = result.revision ?? lastRevision;
      // A skipped damage present drew nothing because nothing changed: the frame on screen still holds the
      // previous present's objects.
      if (result.damage !== "skip") stats.objects = result.draws; }
    startupResourceEvent?.("present", { backendRevision: result.revision ?? null,
      documentNonce: (window as unknown as { __benchDocumentNonce?: string }).__benchDocumentNonce ?? null,
      rendererInstance: startupRendererInstance ?? null, presented: result.presented,
      draws: result.draws, completedFrames: stats.completedFrames, pending: result.resourcePending,
      failure: result.error ?? null });
    if (result.error) stats.scenePresentationFailures++;
    return { presented: result.presented, reason: result.error ?? (result.resourcePending ? "resource pending" : undefined),
      revision: result.revision ?? undefined, draws: result.draws,
      completedFrames: stats.completedFrames };
  }

  async function submit(list: DrawList<string>, text: readonly PixiTextRecord[], plan?: PixiScenePlan,
    diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity): Promise<{ presented: boolean; reason?: string }> {
    if (disposed) return { presented: false, reason: "disposed" };
    // wgpu forbids mapping/consuming a zero-sized instance buffer. More importantly, an empty pre-scene
    // reconcile must not erase the last successfully presented image or its matching hit geometry.
    if (list.count === 0 && text.length === 0) return { presented: false, reason: "empty scene pending" };
    let cardAtlasKey: string | null = null;
    // rustFast `snapshotReuse`: `prefetch` already guards on `textures.has`/`pending.has`/`failures.has` (it is
    // idempotent — confirmed by reading it), so skipping a call for a texture identical to the one just prefetched
    // only saves those three `Map`/`Set` lookups on a run of commands sharing one atlas; it never changes which
    // textures end up fetched.
    let previousPrefetchTexture: string | null = null;
    for (let i = 0; i < list.count; i++) {
      const texture = list.textureAt(i);
      if (texture) {
        if (!fast.snapshotReuse || texture !== previousPrefetchTexture) {
          prefetch(texture);
          previousPrefetchTexture = texture;
        } else {
          prefetchSkips++;
        }
        if (startupEvent && cardAtlasKey === null && isCardAtlas(texture)) cardAtlasKey = texture;
      }
    }
    for (const record of text) {
      const url = (record as InlineImageRecord).inlineImage?.url;
      if (url) prefetch(url);
    }
    stats.resourcePending = pending.size;
    if (pending.size) {
      diagnostic?.({ stage: "texture-pending", dependencyKeys: [...pending.keys()] });
      return { presented: false, reason: "resource pending" };
    }
    logRust("encode", list.count, text.length, nextRevision + 1);
    const revision = ++nextRevision;
    if (textInkDiagnostics) textInkCurrentSubmission = { revision, sceneRevision: null, cacheMisses: 0, rasters: [] };
    const profileCardAtlas = cardAtlasKey !== null && startupEvent !== null && !cardAtlasFirstSubmissionRecorded;
    const encodeStarted = phaseTimingEnabled || profileCardAtlas ? performance.now() : 0;
    const encode = () => serializer.encodeRustScene({ drawList: list, revision, width: surfaceWidth, height: surfaceHeight,
      designWidth: sceneDesignWidth, designHeight: sceneDesignHeight,
      resolveTexture: (texture) => { const image = textures.get(texture); return image ? { key: image.key, width: image.width, height: image.height } : null; },
      texts: text, resolveText, plan, ...(fast.fastSerializer ? { fast: true } : {}) });
    const encoded = profile && profileIdentity ? profile.span(profileIdentity, "couch.text-and-resource-prep", encode) : encode();
    if (profile && profileIdentity) { profile.counter(profileIdentity,
      { sceneBytes: encoded.bytes.byteLength, commands: list.count, textRecords: text.length }); }
    diagnostic?.({ stage: "encoded", operationId: revision, mode: "full-scene" });
    if (textInkCurrentSubmission) {
      textInkCurrentSubmission.sceneRevision = encoded.scene.revision;
      for (const row of textInkCurrentSubmission.rasters) row.sceneRevision = encoded.scene.revision;
    }
    if (phaseTimingEnabled) sceneEncodeMs += performance.now() - encodeStarted;
    if (profileCardAtlas) startupEvent!("cardAtlas.sceneSerialized", { key: cardAtlasKey, scope: "wholeScene", revision,
      durationMs: performance.now() - encodeStarted, sceneBytes: encoded.bytes.byteLength,
      commands: list.count, resources: encoded.resources.length });
    textCount = text.length;
    for (const [kind, count] of Object.entries(encoded.omittedKinds ?? {})) {
      omittedKinds[kind] = (omittedKinds[kind] ?? 0) + count;
    }
    const uploads: ResourcePixels[] = [];
    for (const resource of encoded.resources) {
      if (msdfAtlas.hasPage(resource.key)) continue;
      const data = textures.get(resource.key) ?? bitmap.cachedResource(resource.key);
      if (!data) return { presented: false, reason: `resource bytes unavailable: ${resource.key}` };
      if (!uploaded.has(data.key)) uploads.push(data);
    }
    for (const item of encoded.textUploads) if (!uploaded.has(item.key)) uploads.push(item);
    const uniqueUploads = [...new Map(uploads.map((row) => [row.key, row])).values()];
    const sceneGlyphPages = glyphPages(encoded.scene);
    for (const key of sceneGlyphPages) inFlightGlyphPages.set(key, (inFlightGlyphPages.get(key) ?? 0) + 1);
    // rustTextEvict: pin this submission's Bitmap keys for the same reason `inFlightGlyphPages` pins MSDF
    // pages — see `inFlightTextKeys`'s own comment. No-op while the switch is off (nothing ever reads the pin).
    const sceneTextKeys = fast.textEvict
      ? encoded.resources.filter((resource) => resource.key.startsWith("text:")).map((resource) => resource.key) : [];
    for (const key of sceneTextKeys) inFlightTextKeys.set(key, (inFlightTextKeys.get(key) ?? 0) + 1);
    const cardAtlasUpload = profileCardAtlas
      ? uniqueUploads.find((row) => isCardAtlas(row.key)) ?? null : null;
    if (profileCardAtlas) {
      cardAtlasFirstSubmissionRecorded = true;
      startupEvent!("cardAtlas.firstSubmissionQueued", { key: cardAtlasKey, revision,
      hasAtlasUpload: cardAtlasUpload !== null, rgbaBytes: cardAtlasUpload?.pixels.byteLength ?? null,
      width: cardAtlasUpload?.width ?? null, height: cardAtlasUpload?.height ?? null });
    }
    if (profile && profileIdentity) profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.submission-queue.wait", edge: "start" });
    const operation = submissionTail.then(async () => {
      if (profile && profileIdentity) profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.submission-queue.wait", edge: "end" });
      if (resizeFailure) return { presented: false, reason: `resize failed: ${resizeFailure}` };
      if (profile && profileIdentity) setProfileIdentity(profileIdentity);
      if (profileCardAtlas) startupEvent!("cardAtlas.firstSubmissionStart", { key: cardAtlasKey, revision });
      // Resource replacement and scene presentation share one ordered lane. Uploading outside it lets a newer
      // pixel revision overwrite a texture while an older scene is still being presented.
      if (uniqueUploads.length) {
        const resourceSerializeAt = profileCardAtlas && cardAtlasUpload ? performance.now() : 0;
        const batch = serializer.encodeRustResources(uniqueUploads);
        if (profileCardAtlas && cardAtlasUpload) startupEvent!("cardAtlas.resourcesBatchSerialized", {
          key: cardAtlasKey, scope: "wholeBatch", revision,
          durationMs: performance.now() - resourceSerializeAt, batchBytes: batch.byteLength,
          atlasRgbaBytes: cardAtlasUpload.pixels.byteLength,
          atlasWidth: cardAtlasUpload.width, atlasHeight: cardAtlasUpload.height,
          resourceCount: uniqueUploads.length,
          resources: uniqueUploads.map((item) => ({ key: item.key, rgbaBytes: item.pixels.byteLength })) });
        startupEvent?.("texture.uploadStart", { revision,
          count: uniqueUploads.length, bytes: batch.byteLength,
          pending: pending.size, failed: failures.size });
        const wasmUploadAt = profileCardAtlas && cardAtlasUpload ? performance.now() : 0;
        if (profile && profileIdentity) profile.span(profileIdentity, "couch.wasm-upload-call", () => engine.upload_rgba_batch(batch));
        else engine.upload_rgba_batch(batch);
        wasmUploadCalls++; wasmUploadBytes += batch.byteLength; wasmBytesSent += batch.byteLength;
        startupResourceEvent?.("upload", { revision, batchBytes: batch.byteLength,
          resources: uniqueUploads.map((item) => ({ key: item.key, width: item.width,
            height: item.height, rgbaBytes: item.pixels.byteLength })) });
        if (profileCardAtlas && cardAtlasUpload) startupEvent!("cardAtlas.wasmBatchUpload", {
          key: cardAtlasKey, scope: "wholeBatch", revision, resourceCount: uniqueUploads.length,
          durationMs: performance.now() - wasmUploadAt, batchBytes: batch.byteLength,
          atlasRgbaBytes: cardAtlasUpload.pixels.byteLength });
        startupEvent?.("texture.uploadComplete", { revision,
          count: uniqueUploads.length, bytes: batch.byteLength,
          pending: pending.size, failed: failures.size });
        for (const item of uniqueUploads) { uploaded.add(item.key); uploadedPixels.set(item.key, item); }
      }
      const diffStarted = phaseTimingEnabled ? performance.now() : 0;
      const patch = committedTypedScene
        ? serializer.encodeRustPatch(committedTypedScene, encoded.scene, undefined, fast.fastSerializer ? { fast: true } : undefined)
        : null;
      diagnostic?.({ stage: "api-attempt", operationId: revision, mode: patch ? "scene-patch" : "full-scene" });
      if (phaseTimingEnabled) sceneDiffMs += performance.now() - diffStarted;
      const sceneBytes = !patch || fixtureEnabled ? encoded.bytes : null;
      if (sceneBytes) wasmSceneBytes += sceneBytes.byteLength;
      unsupportedCommands += encoded.unsupportedCommands;
      if (patch) wasmPatchBytes += patch.byteLength;
      const applyStarted = phaseTimingEnabled && patch ? performance.now() : 0;
      const atlasAdmissionAt = profileCardAtlas ? performance.now() : 0;
      const admit = () => patch ? engine.apply_patch(patch) : engine.admit_scene(sceneBytes!);
      const admissionJson = profile && profileIdentity ? profile.span(profileIdentity, "couch.wasm-admission-call", admit) : admit();
      if (profileCardAtlas) startupEvent!("cardAtlas.sceneAdmitted", { key: cardAtlasKey, scope: "wholeScene", revision,
        durationMs: performance.now() - atlasAdmissionAt,
        sceneBytes: patch?.byteLength ?? sceneBytes!.byteLength, patch: !!patch });
      if (phaseTimingEnabled && patch) scenePatchApplyMs += performance.now() - applyStarted;
      wasmBytesSent += patch?.byteLength ?? sceneBytes!.byteLength;
      if (patch) wasmPatchCalls++; else wasmAdmissionCalls++;
      if (patch) stats.scenePatches++; else stats.sceneAdmissions++;
      const admission = parse<{ accepted: boolean; revision: number; unsupportedCommands: number; resourcePending: number; error?: string }>(admissionJson);
      if (profile && profileIdentity) profile.outcome(profileIdentity, admission.accepted ? "accepted" : "refused", admission.error);
      diagnostic?.({ stage: admission.accepted ? "api-accepted" : "api-refused",
        operationId: revision, mode: patch ? "scene-patch" : "full-scene" });
      logRust(patch ? "patch" : "admit", admission);
      stats.resourcePending = admission.resourcePending;
      if (!admission.accepted) {
        if (profileCardAtlas) startupEvent!("cardAtlas.firstSubmissionComplete", { key: cardAtlasKey, revision,
          presented: false, reason: admission.error ?? "scene admission rejected",
          pending: admission.resourcePending });
        if (admission.unsupportedCommands) stats.blockedRefusedFrames++;
        if (admission.error) stats.scenePreflightFailures++;
        return { presented: false, reason: admission.error ?? (admission.resourcePending ? "resource pending" : "scene admission rejected") };
      }
      if (profile && profileIdentity) profile.outcome(profileIdentity, "submitted");
      if (profile && profileIdentity) profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.present.wait", edge: "start" });
      let result: Awaited<ReturnType<typeof presentResult>>;
      try { result = await presentResult(profileIdentity?.operationId ?? revision, profileIdentity); }
      finally { if (profile && profileIdentity) profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.present.wait", edge: "end" }); }
      if (profile && profileIdentity) profile.outcome(profileIdentity, result.presented ? "completed" : "refused", result.reason);
      diagnostic?.({ stage: result.presented ? "presented" : "present-refused", operationId: revision,
        mode: patch ? "scene-patch" : "full-scene" });
      if (profileCardAtlas) startupEvent!("cardAtlas.firstSubmissionComplete", { key: cardAtlasKey, revision,
        presented: result.presented, reason: result.reason ?? null,
        pending: stats.resourcePending, draws: result.draws });
      logRust("present", result);
      if (result.presented) {
        msdfGlyphRunsLastPresented = encoded.scene?.commands?.filter((command) => command.kind === "glyphRun").length ?? 0;
        msdfGlyphRunPresentations += msdfGlyphRunsLastPresented;
        if (firstPresentMs === null) firstPresentMs = performance.now() - startedAt;
        committedScene = sceneBytes;
        committedTypedScene = encoded.scene;
        committedTextCarriers.clear();
        admittedClipRects = new Map();
        for (const command of encoded.scene?.commands ?? []) {
          const rect = command.rect;
          if (command.kind === "clipPush" && Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite))
            admittedClipRects.set(String(command.id), rect.map(Number));
        }
        // rustFast `fastSerializer`: reuse the serializer's own cached index when it offers one, instead of
        // walking `scene.commands` + `String(command.id)` ourselves. Copied into a fresh, OWNED `Map` either way
        // — `committedCommandIndexes` is mutated in place by `submitRetained` below, and a serializer-owned map
        // may be cached/shared across calls, so writing into it directly would be unsafe.
        const fastIndex = fast.fastSerializer ? serializer.rustSceneCommandIndex?.(encoded.scene) : undefined;
        committedCommandIndexes = fastIndex
          ? new Map(fastIndex)
          : new Map((encoded.scene?.commands ?? []).map((command, index) => [String(command.id), index]));
        const nextResources = encoded.resources.map((resource) => uploadedPixels.get(resource.key)!).filter(Boolean);
        // Repacking all atlas pixels is a ~193 MB copy for the accepted quiet scene. Scene revisions often
        // change every replay message while their resource set is identical, so keep the last RSR1 bytes until
        // a key, resource object, or pixel revision actually changes.
        const resourcesChanged = nextResources.length !== committedResources.length ||
          nextResources.some((resource, index) => resource !== committedResources[index]);
        if (resourcesChanged || committedResources.length === 0) {
          committedResources = nextResources;
          committedResourceBuffer = null;
          committedResourceByteLength = 8 + committedResources.reduce((bytes, item) =>
            bytes + 16 + new TextEncoder().encode(item.key).byteLength + item.pixels.byteLength, 0);
        }
        committedRevision = revision;
        lastRevision = revision;
        // `!disposed`, mirroring `submitRetained`'s `result.presented && !disposed`: `dispose()` may have torn
        // down `engine` while this continuation was awaiting `presentResult`, and a release must never touch it.
        if (fast.textEvict && !disposed) evictUnreferencedText(encoded.resources);
      }
      return result;
    });
    const settled = operation.finally(() => {
      for (const key of sceneGlyphPages) {
        const count = (inFlightGlyphPages.get(key) ?? 1) - 1;
        if (count) inFlightGlyphPages.set(key, count); else inFlightGlyphPages.delete(key);
      }
      for (const key of sceneTextKeys) {
        const count = (inFlightTextKeys.get(key) ?? 1) - 1;
        if (count) inFlightTextKeys.set(key, count); else inFlightTextKeys.delete(key);
      }
      if (profile && profileIdentity) setProfileIdentity(profileIdentity, 0);
    });
    submissionTail = settled.then(() => undefined, () => undefined);
    return settled;
  }

  /** rustTextPatch: whether this serializer and renderer can patch a re-prepared label (both probed, never polled). */
  const patchesText = () => fast.textPatch && serializer.RUST_RETAINED_TEXT_PATCH === true && engine.patch_resources === true;
  function encodeRetainedPatch(patch: ClipTranslatingScenePatch): RetainedPatchEncoding | null {
    const started = phaseTimingEnabled ? performance.now() : 0;
    const base = committedTypedScene;
    const encode = serializer.encodeRustRetainedPatch;
    if (!base || !encode || committedRevision === null || base.width !== surfaceWidth || base.height !== surfaceHeight ||
        base.designWidth !== sceneDesignWidth || base.designHeight !== sceneDesignHeight) return null;
    const updates = new Map<string, { id: string; command: Record<string, unknown>; localTransform?: readonly number[] }>();
    const toRustId = (id: string) => id.startsWith("text:") ? `t${id.slice(5)}` : id;
    for (const change of patch.primitives ?? []) {
      if (change.tint !== undefined) return null;
      const id = toRustId(change.id), commandIndex = committedCommandIndexes.get(id), old = commandIndex === undefined ? undefined : base.commands[commandIndex];
      if (!old || (old.kind !== "quad" && old.kind !== "ninePatch" && old.kind !== "rasterText" && old.kind !== "glyphRun" && old.kind !== "stillImage")) return null;
      const command: Record<string, unknown> = { ...old };
      const update: { id: string; command: Record<string, unknown>; localTransform?: readonly number[] } = { id, command };
      if (change.transform) {
        if (old.kind === "rasterText" || old.kind === "glyphRun") update.localTransform = change.transform;
        else command.m = [...change.transform];
      }
      if (change.alpha !== undefined) {
        if (old.kind === "glyphRun") {
          if (!Number.isFinite(change.alpha) || change.alpha < 0 || change.alpha > 1) return null;
          command.alpha = change.alpha;
        } else {
          const color = old.color;
          if (!Array.isArray(color) || color.length !== 4 || !Number.isFinite(color[3]) || color[3] <= 0) return null;
          const ratio = change.alpha / Number(color[3]);
          command.color = color.map((channel) => Number(channel) * ratio);
        }
      }
      if (change.source) {
        if (old.kind === "glyphRun") return null;
        const source = change.source as { texture: string | null; x: number; y: number; w: number; h: number };
        if (source.texture !== null && !base.resources.some((resource) => resource.key === source.texture)) return null;
        command.resource = source.texture;
        command.src = [source.x, source.y, source.w, source.h];
      }
      updates.set(id, update);
    }
    // rustOffsetPatch: a clip moved by translation. The serializer names an unplanned command `c<list index>`, and
    // Couch never plans a clip push or places one under a group, so its rect is in design space and moves as is.
    // The rect is recomputed from the admitted one plus the clip's total translation, never accumulated per patch.
    for (const clip of patch.clips ?? []) {
      const id = `c${clip.index}`, commandIndex = committedCommandIndexes.get(id);
      const old = commandIndex === undefined ? undefined : base.commands[commandIndex];
      const rect = admittedClipRects.get(id);
      if (!old || old.kind !== "clipPush" || !rect || updates.has(id)) return null;
      updates.set(id, { id, command: { ...old, rect: [rect[0] + clip.totalDx, rect[1] + clip.totalDy, rect[2], rect[3]] } });
    }
    const groups = (patch.groups ?? []).filter((group): group is typeof group & { transform: readonly number[] } => group.transform !== undefined)
      .map(({ id, transform }) => ({ id, transform }));
    if ((patch.groups?.some((group) => group.alpha !== undefined) ?? false) || groups.some((group) => !group.transform)) return null;
    // rustTextPatch: each re-prepared label resolves through the full build's own text method (a Bitmap raster or an
    // MSDF glyph run); the serializer then emits the command a full build would for it.
    let texts: { record: PixiTextRecord; carrier: RustTextCarrier }[] | undefined;
    if (patch.texts?.length) {
      if (!patchesText()) return null;
      texts = [];
      for (const record of patch.texts) {
        if (updates.has(toRustId(`text:${record.key}`))) return null;
        const carrier = resolveText(record);
        if (!carrier) return null;
        texts.push({ record, carrier });
      }
    }
    const result = texts ? encode(base, ++nextRevision, [...updates.values()], groups, undefined, { texts })
      : encode(base, ++nextRevision, [...updates.values()], groups);
    if (result && texts) result.preparedTexts = texts;
    retainedPatchEncodes++;
    if (phaseTimingEnabled) retainedPatchEncodeMs += performance.now() - started;
    return result;
  }

  function submitRetained(patch: ClipTranslatingScenePatch, diagnostic?: (event: ProducerExecutorEvent) => void,
    profileIdentity?: ProfileIdentity): Promise<{ presented: boolean; reason?: string }> {
    if (disposed) return Promise.resolve({ presented: false, reason: "disposed" });
    if (retainedPatchInFlight) return Promise.resolve({ presented: false, reason: "retained patch already in flight" });
    const encoded = encodeRetainedPatch(patch);
    if (!encoded) return Promise.resolve({ presented: false, reason: "retained patch requires full scene admission" });
    diagnostic?.({ stage: "encoded", operationId: encoded.scene.revision, mode: "scene-patch" });
    retainedPatchInFlight = true;
    // rustTextPatch: a patched label's glyph pages stay resident while the patch is in flight, as a build's do.
    const patchGlyphPages = patch.texts?.length ? glyphPages(encoded.scene) : [];
    for (const key of patchGlyphPages) inFlightGlyphPages.set(key, (inFlightGlyphPages.get(key) ?? 0) + 1);
    // rustTextPatch + rustTextEvict: the raster keys a text patch names are pinned while it is in flight, exactly as
    // a full build's are, so an eviction cannot release a patched-in key before the patch commits.
    const patchTextKeys = fast.textEvict && encoded.resourcesChanged
      ? encoded.scene.resources.filter((resource) => resource.key.startsWith("text:")).map((resource) => resource.key) : [];
    for (const key of patchTextKeys) inFlightTextKeys.set(key, (inFlightTextKeys.get(key) ?? 0) + 1);
    const queuedAt = phaseTimingEnabled ? performance.now() : 0;
    if (profile && profileIdentity) profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.submission-queue.wait", edge: "start" });
    const operation = submissionTail.then(async () => {
      if (profile && profileIdentity) profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.submission-queue.wait", edge: "end" });
      if (phaseTimingEnabled) retainedPatchQueueWaitMs += performance.now() - queuedAt;
      if (resizeFailure || disposed) return { presented: false, reason: resizeFailure ? `resize failed: ${resizeFailure}` : "disposed" };
      // rustTextPatch: a new raster is resident before the patch that names it, in the same ordered lane.
      const textUploads = (encoded.textUploads ?? []).filter((item) => !uploaded.has(item.key));
      if (textUploads.length) {
        const unique = [...new Map(textUploads.map((item) => [item.key, item])).values()];
        const batch = serializer.encodeRustResources(unique);
        engine.upload_rgba_batch(batch);
        wasmUploadCalls++; wasmUploadBytes += batch.byteLength; wasmBytesSent += batch.byteLength;
        for (const item of unique) { uploaded.add(item.key); uploadedPixels.set(item.key, item); }
      }
      const applyStarted = phaseTimingEnabled ? performance.now() : 0;
      diagnostic?.({ stage: "api-attempt", operationId: encoded.scene.revision, mode: "scene-patch" });
      if (profile && profileIdentity) setProfileIdentity(profileIdentity);
      const admissionJson = profile && profileIdentity
        ? profile.span(profileIdentity, "couch.wasm-admission-call", () => engine.apply_patch(encoded.bytes))
        : engine.apply_patch(encoded.bytes);
      if (phaseTimingEnabled) retainedPatchApplyMs += performance.now() - applyStarted;
      wasmPatchCalls++; wasmPatchBytes += encoded.bytes.byteLength; wasmBytesSent += encoded.bytes.byteLength; stats.scenePatches++;
      const admission = parse<{ accepted: boolean; revision: number; unsupportedCommands?: number; resourcePending: number; error?: string }>(admissionJson);
      stats.resourcePending = admission.resourcePending;
      if (!admission.accepted) {
        if (profile && profileIdentity) profile.outcome(profileIdentity, "refused", admission.error);
        diagnostic?.({ stage: "api-refused", operationId: encoded.scene.revision, mode: "scene-patch" });
        if (admission.unsupportedCommands) stats.blockedRefusedFrames++;
        if (admission.error) stats.scenePreflightFailures++;
        return { presented: false, reason: admission.error ?? (admission.resourcePending ? "resource pending" : "scene patch rejected") };
      }
      diagnostic?.({ stage: "api-accepted", operationId: encoded.scene.revision, mode: "scene-patch" });
      if (profile && profileIdentity) profile.outcome(profileIdentity, "accepted");
      const presentAt = phaseTimingEnabled ? performance.now() : 0;
      diagnostic?.({ stage: "present-call", operationId: encoded.scene.revision, mode: "scene-patch" });
      if (profile && profileIdentity) profile.outcome(profileIdentity, "submitted");
      if (profile && profileIdentity) profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.present.wait", edge: "start" });
      let result: Awaited<ReturnType<typeof presentResult>>;
      try { result = await presentResult(profileIdentity?.operationId ?? encoded.scene.revision, profileIdentity); }
      finally { if (profile && profileIdentity) profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.present.wait", edge: "end" }); }
      if (profile && profileIdentity) profile.outcome(profileIdentity, result.presented ? "completed" : "refused", result.reason);
      diagnostic?.({ stage: result.presented ? "presented" : "present-refused",
        operationId: encoded.scene.revision, mode: "scene-patch" });
      if (phaseTimingEnabled) retainedPatchPresentWaitMs += performance.now() - presentAt;
      if (result.presented && !disposed) {
        msdfGlyphRunsLastPresented = encoded.scene?.commands?.filter((command) => command.kind === "glyphRun").length ?? 0;
        msdfGlyphRunPresentations += msdfGlyphRunsLastPresented;
        committedTypedScene = encoded.scene;
        for (const index of encoded.changedIndexes) {
          const id = encoded.scene.commands[index]?.id;
          if (id !== undefined) committedCommandIndexes.set(String(id), index);
        }
        committedRevision = encoded.scene.revision;
        lastRevision = encoded.scene.revision;
        committedScene = fixtureEnabled ? new TextEncoder().encode(JSON.stringify(encoded.scene)) : null;
        committedResourceBuffer = null;
        if (encoded.resourcesChanged) {
          textPatchResourceChanges++;
          committedResources = encoded.scene.resources.map((resource) => uploadedPixels.get(resource.key)!).filter(Boolean);
          committedResourceByteLength = 8 + committedResources.reduce((bytes, item) =>
            bytes + 16 + new TextEncoder().encode(item.key).byteLength + item.pixels.byteLength, 0);
        }
        if (patch.texts?.length) textPatchCommits++;
        if (fast.verify) for (const prepared of encoded.preparedTexts ?? []) committedTextCarriers.set(`t${prepared.record.key}`, prepared);
        // MSDF: a glyph page this patch stops naming is released the same way as after a full build — never by
        // reference count, only when the atlas needs room (`MsdfAtlas.flush`, pinned by the committed scene this
        // assignment just updated and by in-flight submissions).
        // rustTextEvict: the committed scene now names the patched-in key and no longer the replaced one, so the
        // tracker sees the new key referenced and moves the old one into its recently-unreferenced pool.
        if (encoded.resourcesChanged && fast.textEvict && !disposed) evictUnreferencedText(encoded.scene.resources);
      }
      return result;
    });
    const settled = operation.finally(() => { retainedPatchInFlight = false;
      for (const key of patchGlyphPages) {
        const count = (inFlightGlyphPages.get(key) ?? 1) - 1;
        if (count) inFlightGlyphPages.set(key, count); else inFlightGlyphPages.delete(key);
      }
      for (const key of patchTextKeys) {
        const count = (inFlightTextKeys.get(key) ?? 1) - 1;
        if (count) inFlightTextKeys.set(key, count); else inFlightTextKeys.delete(key);
      }
      if (profile && profileIdentity) setProfileIdentity(profileIdentity, 0); });
    submissionTail = settled.then(() => undefined, () => undefined);
    return settled;
  }

  return {
    app, stats,
    get translatesClips() { return translatesClips(); },
    // rustTextEvict diagnostics: `resources` stays flat while the switch is on (bounded by the eviction pool
    // plus whatever the committed scene currently references) and grows without bound while it is off.
    get rustTextEvictions() { return textEvictions; },
    get rustTextCacheResources() { return bitmap.stats().resources; },
    // rustDamagePresent diagnostics: the renderer's cumulative partial/full/skipped presents (null while off or
    // before the first present). `verifyMismatches` is the rustFastVerify shadow check and must stay 0.
    get rustDamage() { return damagePresent && rustDamageStats ? { ...rustDamageStats, last: rustLastDamage } : null; },
    // rustPresent diagnostics: which mode this engine actually presents through, and the pixels its blits moved —
    // a cumulative total across this engine's lifetime plus the last present's own count.
    get rustPresentMode() { return rustLastPresentMode ?? appliedPresentMode; },
    get rustBlitPixels() { return { total: rustBlitPixelsTotal, last: rustLastBlitPixels }; },
    resize(nextWidth: number, nextHeight: number, _resolution = 1, nextDesignWidth = nextWidth, nextDesignHeight = nextHeight) {
      surfaceWidth = nextWidth; surfaceHeight = nextHeight;
      sceneDesignWidth = nextDesignWidth; sceneDesignHeight = nextDesignHeight;
      canvas.width = nextWidth; canvas.height = nextHeight;
      presentationValid = false; stats.presentationValid = false;
      const operation = submissionTail.then(() => {
        try {
          engine.resize(nextWidth, nextHeight); wasmResizeCalls++; resizeFailure = null;
        } catch (error) {
          resizeFailure = error instanceof Error ? error.message : String(error);
          stats.scenePresentationFailures++;
        }
      });
      submissionTail = operation.then(() => undefined, () => undefined);
    },
    render(list: DrawList<string>, text: readonly PixiTextRecord[] = [], profileIdentity?: ProfileIdentity) { stats.objects = list.count;
      const result = submit(list, text, undefined, undefined, profileIdentity);
      return startupResourceEvent ? result : result.then((value) => value.presented); },
    admitScene(list: DrawList<string>, text: readonly PixiTextRecord[] = [], plan: PixiScenePlan,
      diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity) { stats.objects = list.count; return submit(list, text, plan, diagnostic, profileIdentity); },
    patchScene(patch: ClipTranslatingScenePatch, diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity) {
      return submitRetained(patch, diagnostic, profileIdentity);
    },
    presentScene(diagnostic?: (event: ProducerExecutorEvent) => void, profileIdentity?: ProfileIdentity) {
      if (profile && profileIdentity) {
        profile.outcome(profileIdentity, "accepted");
        profile.outcome(profileIdentity, "submitted");
        profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.submission-queue.wait", edge: "start" });
        const operation = submissionTail.then(() => {
          profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.submission-queue.wait", edge: "end" });
          profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.present.wait", edge: "start" });
          return presentResult(profileIdentity.operationId, profileIdentity);
        }).then((result) => {
          profile.outcome(profileIdentity, result.presented ? "completed" : "refused", result.reason);
          return result;
        }).finally(() => { profile.emit(profileIdentity, { eventType: "phase-edge", phase: "couch.present.wait", edge: "end" });
          setProfileIdentity(profileIdentity, 0); });
        submissionTail = operation.then(() => undefined, () => undefined);
        return operation;
      }
      if (!executionPhases || !diagnostic) return presentResult();
      if (nextRevision >= 0x80000000 || nextPresentOnlyPhaseId > 0xffffffff)
        throw new Error("Rust present-only phase ID namespace exhausted");
      const operationId = nextPresentOnlyPhaseId++;
      diagnostic({ stage: "api-accepted", operationId, mode: "present-only" });
      diagnostic({ stage: "present-call", operationId, mode: "present-only" });
      return presentResult(operationId).then((result) => {
        diagnostic({ stage: result.presented ? "presented" : "present-refused", operationId, mode: "present-only" });
        return result;
      });
    },
    prefetch,
    get patchesText() { return patchesText(); },
    verifyTextCommands(records: readonly PixiTextRecord[]): string[] {
      // Side-effect free: no resolve. The rebuilt record must ask for exactly what the patch's record asked for
      // (the Bitmap resource key's inputs, MSDF shaping inputs, placement), and the committed command must be the
      // one the patch's own carrier produces.
      const scene = committedTypedScene, notes: string[] = [];
      if (!scene) return ["no committed scene"];
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const asks = (record: PixiTextRecord) => {
        const extra = record as PixiTextRecord & Record<string, unknown>;
        return JSON.stringify([record.key, record.resourceRevision ?? record.contentKey ?? "", record.text, record.style,
          record.tint ?? 0xffffff, record.alpha, extra.runs, extra.msdf, extra.inlineImage, record.transform,
          extra.localTransform]);
      };
      for (const record of records) {
        const id = `t${record.key}`, at = committedCommandIndexes.get(id);
        const command = at === undefined ? undefined : scene.commands[at];
        const prepared = committedTextCarriers.get(id);
        if (!command || !prepared) { notes.push(`${id}: ${command ? "not patched" : "no command"}`); continue; }
        if (asks(prepared.record) !== asks(record)) { notes.push(`${id}: patched record differs from the rebuilt one`); continue; }
        const { carrier } = prepared;
        if (carrier.kind === "glyphs") {
          if (command.kind !== "glyphRun" || command.atlas !== carrier.atlas.key ||
              !same(command.glyphs, carrier.glyphs.map(({ src, dst }) => ({ src, dst }))) ||
              !same(command.fill, carrier.fill) || !same(command.outline, carrier.outline ?? null) ||
              !same(command.shadow, carrier.shadow ?? null) || command.pxRange !== carrier.pxRange ||
              command.alpha !== (carrier.alpha ?? record.alpha ?? 1))
            notes.push(`${id}: glyph run differs from its carrier`);
          continue;
        }
        const alpha = carrier.alpha ?? record.alpha ?? 1;
        const listed = scene.resources.find((resource) => resource.key === carrier.resource.key);
        if (command.kind !== "rasterText" || command.resource !== carrier.resource.key || command.w !== carrier.width ||
            command.h !== carrier.height || !same(command.src, [0, 0, carrier.resource.width, carrier.resource.height]) ||
            !same(command.color, [alpha, alpha, alpha, alpha]) || listed?.width !== carrier.resource.width ||
            listed.height !== carrier.resource.height)
          notes.push(`${id}: raster ${String(command.resource)} committed, ${carrier.resource.key} prepared`);
      }
      return notes;
    },
    /** rustTextPatch diagnostics: committed text patches against full admissions and Rust geometry work. */
    get rustTextPatchStats() { return { textPatchCommits, textPatchResourceChanges, sceneAdmissions: wasmAdmissionCalls,
      scenePatches: wasmPatchCalls, rustGeometryRebuilds, rustIncrementalPatches,
      textRasterizations: stats.textRasterizations, msdfFallbackReasons: { ...msdfFallbackReasons },
      msdfFallbackLabels: { ...msdfFallbackLabels } }; },
    bindPixelTexture(key: string, source: HTMLCanvasElement, revision: number) {
      if (pixelRevisions.get(key) === revision) return;
      pixelRevisions.set(key, revision);
      cacheCanvasTexture(key, source);
    },
    textureSize(key: string) { const item = textures.get(key); return item ? { width: item.width, height: item.height } : null; },
    textureFailureDetails() { return [...failures].map(([key, reason]) => `${key}: ${reason}`); },
    textOutcomes(): PixiTextOutcomes { return { requested: "native", actual: "native", native: textCount, slug: 0, slugCached: 0, reasons: {} }; },
    armDiagnosticSkipGl() { return false; }, armDiagnosticSingleQuad() { return false; }, pollDiagnostics() {},
    dispose() { if (disposed) return; disposed = true; canvas.removeEventListener("webglcontextlost", contextLost); canvas.removeEventListener("webglcontextrestored", contextRestored); if (fixtureEnabled) { delete globals.__mirrorRustFixture; delete globals.__mirrorRustFixtureChunk; } if (statsEnabled) delete globals.__mirrorRustStats; delete globals.__mirrorRustGpuTimerCapability; delete globals.__mirrorRustTextCorpus; delete globals.__mirrorRustRollbackProbe; delete (window as unknown as { __mirrorRustPixelControl?: boolean }).__mirrorRustPixelControl; msdfAtlas.dispose(); msdfRuntime?.dispose(); engine.dispose(); textures.clear(); bitmap.dispose(); pixelRevisions.clear(); uploaded.clear(); uploadedPixels.clear(); inFlightTextKeys.clear(); pending.clear(); failures.clear(); committedResources = []; committedScene = null; committedTypedScene = null; committedCommandIndexes.clear(); committedResourceBuffer = null; committedRevision = null; },
  } as unknown as PixiDrawListRenderer<string> & {
    render(list: DrawList<string>, text?: readonly PixiTextRecord[]): Promise<boolean>;
    admitScene(list: DrawList<string>, text: readonly PixiTextRecord[], plan: PixiScenePlan): Promise<{ presented: boolean; reason?: string }>;
    patchScene(patch: PixiScenePatch<string>): Promise<{ presented: boolean; reason?: string }>;
    presentScene(diagnostic?: (event: ProducerExecutorEvent) => void): Promise<{ presented: boolean; reason?: string }>;
  };
};
