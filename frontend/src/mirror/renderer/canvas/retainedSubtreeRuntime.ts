import {
  COLOR_MATRIX_FLOATS,
  commandDamageBounds,
  createDamageRect,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_QUAD,
  transformDamageRect,
  unionDamageRect,
  type CompiledRefreshResult,
  type DamageRect,
  type DrawList,
  type ExecutorStats,
  type ExecutorTexture,
  type RetainedRangeCache,
  type RetainedRangeCandidate,
  type RetainedRangeSubstitutionPlan,
  type StageProjection,
} from "@godot-scene-web/canvas";

import type { DrawListBuild } from "@/mirror/canvas/buildDrawList";
import {
  planRetainedSubtreeCandidates,
  RETAINED_SUBTREE_GUTTER_PX,
  RETAINED_SUBTREE_REJECT_REASONS,
  type RetainedSubtreeCandidate,
  type RetainedSubtreeCandidatePlan,
  type RetainedSubtreeRejectReason,
} from "@/mirror/canvas/retainedSubtreeCandidates";

export type RetainedSubtreeInvalidationReason =
  | "content"
  | "transform"
  | "clip"
  | "topology"
  | "resize"
  | "rasterScale"
  | "context"
  | "dispose";

export interface RetainedSubtreeRuntimeStats {
  readonly enabled: boolean;
  readonly plans: number;
  readonly considered: number;
  readonly selected: number;
  readonly selectedPixels: number;
  readonly selectedBytes: number;
  readonly translationReuses: number;
  readonly contentInvalidations: number;
  readonly transformFallbacks: number;
  readonly liveFallbacks: number;
  readonly invalidations: Readonly<Record<RetainedSubtreeInvalidationReason, number>>;
  readonly rejected: Readonly<Record<RetainedSubtreeRejectReason, number>>;
  readonly execution: Readonly<RetainedSubtreeExecutionTotals>;
}

export interface RetainedSubtreeExecutionTotals {
  logicalCommands: number;
  liveCommands: number;
  substitutedCommands: number;
  retainedComposites: number;
  retainedRasterizations: number;
  retainedFallbacks: number;
  retainedRasterPixels: number;
  retainedCompositePixels: number;
  glyphRuns: number;
  glyphDrawCalls: number;
  batches: number;
  textureBinds: number;
  compiledGpuFullUploads: number;
  compiledGpuRangeUploads: number;
  compiledGpuFullUploadBytes: number;
  compiledGpuRangeUploadBytes: number;
}

export interface RetainedSubtreeRuntime {
  readonly enabled: boolean;
  readonly stats: RetainedSubtreeRuntimeStats;
  readonly candidatePlan: RetainedSubtreeCandidatePlan | null;
  planBuild(
    build: DrawListBuild,
    list: DrawList<ExecutorTexture | null>,
    projection: StageProjection,
  ): void;
  prepare(
    list: DrawList<ExecutorTexture | null>,
    projection: StageProjection,
    refresh: CompiledRefreshResult,
  ): RetainedRangeSubstitutionPlan | undefined;
  invalidateAll(reason: RetainedSubtreeInvalidationReason): void;
  noteExecution(stats: ExecutorStats): void;
  contextLost(): void;
  dispose(): void;
}

interface CommandFingerprint {
  readonly kind: number;
  readonly texture: unknown;
  readonly floats: Float32Array;
  readonly ints: Int32Array;
  readonly colorMatrix: Float32Array | null;
}

interface CandidateState {
  candidate: RetainedSubtreeCandidate;
  fingerprints: CommandFingerprint[];
  pixelRevision: number;
  omitOnce: boolean;
  suppressed: boolean;
}

const INVALIDATION_REASONS: readonly RetainedSubtreeInvalidationReason[] = [
  "content",
  "transform",
  "clip",
  "topology",
  "resize",
  "rasterScale",
  "context",
  "dispose",
];

function reasonCounts(): Record<RetainedSubtreeInvalidationReason, number> {
  return Object.fromEntries(INVALIDATION_REASONS.map((reason) => [reason, 0])) as Record<
    RetainedSubtreeInvalidationReason,
    number
  >;
}

export function canvasSubtreeCacheEnabled(search: string): boolean {
  try {
    return new URLSearchParams(search).get("canvasSubtreeCache") === "on";
  } catch {
    return false;
  }
}

function commandLengths<TTexture>(list: DrawList<TTexture>, index: number): { floats: number; ints: number } {
  const kind = list.kindAt(index);
  if (kind === DRAW_QUAD) return { floats: 16, ints: 3 };
  if (kind === DRAW_NINE_PATCH) return { floats: 20, ints: 3 };
  if (kind === DRAW_GLYPHS) {
    const glyphs = list.ints[list.intOffsetAt(index)];
    return { floats: 17 + glyphs * 2, ints: 1 + glyphs };
  }
  if (kind === DRAW_CLIP_PUSH) return { floats: 6, ints: 0 };
  if (kind === DRAW_CLIP_POP) return { floats: 0, ints: 0 };
  return { floats: 0, ints: 0 };
}

function fingerprints<TTexture>(list: DrawList<TTexture>, candidate: RetainedRangeCandidate): CommandFingerprint[] {
  const result: CommandFingerprint[] = [];
  for (let index = candidate.start; index < candidate.end; index++) {
    const lengths = commandLengths(list, index);
    const floatAt = list.floatOffsetAt(index);
    const intAt = list.intOffsetAt(index);
    result.push({
      kind: list.kindAt(index),
      // Per-command identity matters. A dependency-set scan cannot distinguish
      // [A,B,B] from [A,A,B], even though the pixels differ.
      texture: list.textureAt(index),
      floats: list.floats.slice(floatAt, floatAt + lengths.floats),
      ints: list.ints.slice(intAt, intAt + lengths.ints),
      colorMatrix: (() => {
        const matrix = list.colorMatrixIndexAt(index);
        const offset = matrix * COLOR_MATRIX_FLOATS;
        return matrix >= 0
          ? list.colorMatrices.slice(offset, offset + COLOR_MATRIX_FLOATS)
          : null;
      })(),
    });
  }
  return result;
}

function equalNumbers(a: ArrayLike<number>, b: ArrayLike<number>, skipA = -1, skipB = -1): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (index === skipA || index === skipB) continue;
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

function equalPayloadOutsideMatrix(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 6; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

type FingerprintChange =
  | { readonly kind: "same" }
  | { readonly kind: "translation"; readonly dx: number; readonly dy: number }
  | { readonly kind: "content" }
  | { readonly kind: "clip" }
  | { readonly kind: "transform" };

function classifyFingerprints(
  before: readonly CommandFingerprint[],
  after: readonly CommandFingerprint[],
): FingerprintChange {
  if (before.length !== after.length) return { kind: "content" };
  let dx: number | null = null;
  let dy: number | null = null;
  let moved = false;
  let hasInternalClip = false;
  for (let index = 0; index < before.length; index++) {
    const oldCommand = before[index];
    const newCommand = after[index];
    if (oldCommand.kind !== newCommand.kind) return { kind: "content" };
    if (oldCommand.kind === DRAW_CLIP_PUSH || oldCommand.kind === DRAW_CLIP_POP) {
      hasInternalClip = true;
      if (!equalNumbers(oldCommand.floats, newCommand.floats) || !equalNumbers(oldCommand.ints, newCommand.ints)) {
        return { kind: "clip" };
      }
      continue;
    }
    if (!Object.is(oldCommand.texture, newCommand.texture)) return { kind: "content" };
    if (!equalNumbers(oldCommand.ints, newCommand.ints)) return { kind: "content" };
    if (
      (oldCommand.colorMatrix === null) !== (newCommand.colorMatrix === null) ||
      (oldCommand.colorMatrix !== null &&
        newCommand.colorMatrix !== null &&
        !equalNumbers(oldCommand.colorMatrix, newCommand.colorMatrix))
    ) {
      return { kind: "content" };
    }
    if (!equalPayloadOutsideMatrix(oldCommand.floats, newCommand.floats)) return { kind: "content" };
    for (let component = 0; component < 4; component++) {
      if (!Object.is(oldCommand.floats[component], newCommand.floats[component])) {
        return { kind: "transform" };
      }
    }
    const commandDx = newCommand.floats[4] - oldCommand.floats[4];
    const commandDy = newCommand.floats[5] - oldCommand.floats[5];
    if (dx === null) {
      dx = commandDx;
      dy = commandDy;
    } else if (!Object.is(dx, commandDx) || !Object.is(dy, commandDy)) {
      return { kind: "transform" };
    }
    moved ||= commandDx !== 0 || commandDy !== 0;
  }
  // Moving paint beneath a stationary internal clip is not a translation of
  // the interval's raster result. The intentionally conservative policy also
  // refuses moving clip geometry, which is already classified as `clip`.
  if (moved && hasInternalClip) return { kind: "transform" };
  return moved ? { kind: "translation", dx: dx ?? 0, dy: dy ?? 0 } : { kind: "same" };
}

function candidateBounds<TTexture>(
  list: DrawList<TTexture>,
  candidate: RetainedRangeCandidate,
): DamageRect | null {
  const scratch = createDamageRect();
  const union = createDamageRect();
  const result = createDamageRect();
  let haveBounds = false;
  for (let index = candidate.start; index < candidate.end; index++) {
    const kind = list.kindAt(index);
    if (kind === DRAW_CLIP_PUSH || kind === DRAW_CLIP_POP) continue;
    const bounds = commandDamageBounds(list, index, scratch);
    if (bounds === null) return null;
    if (!haveBounds) {
      Object.assign(result, bounds);
      haveBounds = true;
    } else {
      unionDamageRect(result, bounds, union);
      Object.assign(result, union);
    }
  }
  return haveBounds ? result : null;
}

function rasterFootprint(bounds: DamageRect, projection: StageProjection): DamageRect {
  const transformed = transformDamageRect(bounds, projection.toFramebuffer, createDamageRect());
  const left = Math.floor(transformed.x) - RETAINED_SUBTREE_GUTTER_PX;
  const top = Math.floor(transformed.y) - RETAINED_SUBTREE_GUTTER_PX;
  const right = Math.ceil(transformed.x + transformed.width) + RETAINED_SUBTREE_GUTTER_PX;
  const bottom = Math.ceil(transformed.y + transformed.height) + RETAINED_SUBTREE_GUTTER_PX;
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function integerDeviceTranslation(change: Extract<FingerprintChange, { kind: "translation" }>, projection: StageProjection): boolean {
  const matrix = projection.toFramebuffer;
  const dx = matrix[0] * change.dx + matrix[2] * change.dy;
  const dy = matrix[1] * change.dx + matrix[3] * change.dy;
  return Math.abs(dx - Math.round(dx)) <= 1e-5 && Math.abs(dy - Math.round(dy)) <= 1e-5;
}

function sameFootprintSize(a: DamageRect, b: DamageRect): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * Consumer-side ownership and invalidation for GSW's generic retained cache.
 * The logical list and hit snapshot never change: this runtime only supplies
 * an opaque physical-execution substitution plan at paint time.
 */
export function createRetainedSubtreeRuntime(options: {
  readonly enabled: boolean;
  readonly cache: RetainedRangeCache;
}): RetainedSubtreeRuntime {
  let candidatePlan: RetainedSubtreeCandidatePlan | null = null;
  let states = new Map<string, CandidateState>();
  let disposed = false;
  let projectionKey: string | null = null;
  let pendingBuildFingerprint: { structuralRevision: number; contentRevision: number } | null = null;
  const invalidations = reasonCounts();
  const rejected = Object.fromEntries(RETAINED_SUBTREE_REJECT_REASONS.map((reason) => [reason, 0])) as Record<
    RetainedSubtreeRejectReason,
    number
  >;
  const execution: RetainedSubtreeExecutionTotals = {
    logicalCommands: 0,
    liveCommands: 0,
    substitutedCommands: 0,
    retainedComposites: 0,
    retainedRasterizations: 0,
    retainedFallbacks: 0,
    retainedRasterPixels: 0,
    retainedCompositePixels: 0,
    glyphRuns: 0,
    glyphDrawCalls: 0,
    batches: 0,
    textureBinds: 0,
    compiledGpuFullUploads: 0,
    compiledGpuRangeUploads: 0,
    compiledGpuFullUploadBytes: 0,
    compiledGpuRangeUploadBytes: 0,
  };
  const mutableStats = {
    enabled: options.enabled,
    plans: 0,
    considered: 0,
    selected: 0,
    selectedPixels: 0,
    selectedBytes: 0,
    translationReuses: 0,
    contentInvalidations: 0,
    transformFallbacks: 0,
    liveFallbacks: 0,
    invalidations,
    rejected,
    execution,
  };

  function note(reason: RetainedSubtreeInvalidationReason): void {
    invalidations[reason]++;
  }

  function observeProjection(projection: StageProjection): void {
    const next = [
      projection.designWidth,
      projection.designHeight,
      projection.framebufferWidth,
      projection.framebufferHeight,
      ...projection.toFramebuffer,
    ].join(",");
    if (projectionKey !== null && projectionKey !== next) invalidateAll("rasterScale");
    projectionKey = next;
  }

  function planBuild(
    build: DrawListBuild,
    list: DrawList<ExecutorTexture | null>,
    projection: StageProjection,
  ): void {
    if (!options.enabled || disposed) return;
    observeProjection(projection);
    const previous = states;
    const provisional = planRetainedSubtreeCandidates(build, list, projection);
    const next = new Map<string, CandidateState>();
    const candidates: RetainedSubtreeCandidate[] = [];
    for (const candidate of provisional.candidates) {
      const old = previous.get(candidate.key);
      const nextFingerprints = fingerprints(list, candidate);
      let pixelRevision = old?.pixelRevision ?? 0;
      let omitOnce = false;
      if (old !== undefined && (
        old.candidate.start !== candidate.start ||
        old.candidate.end !== candidate.end ||
        old.candidate.ownerOrder !== candidate.ownerOrder ||
        old.candidate.ownershipKey !== candidate.ownershipKey
      )) {
        pixelRevision++;
        options.cache.invalidate(candidate.key, "topology");
        note("topology");
      } else if (old !== undefined) {
        const change = classifyFingerprints(old.fingerprints, nextFingerprints);
        if (change.kind !== "same" && change.kind !== "translation") {
          pixelRevision++;
          mutableStats.contentInvalidations++;
          note(change.kind === "clip" ? "clip" : change.kind === "transform" ? "transform" : "content");
          if (change.kind === "clip" || change.kind === "transform") {
            options.cache.invalidate(candidate.key, change.kind);
            mutableStats.transformFallbacks++;
            omitOnce = true;
          }
        } else if (change.kind === "translation") {
          const oldFootprint = rasterFootprint(old.candidate.bounds, projection);
          const nextFootprint = rasterFootprint(candidate.bounds, projection);
          if (!integerDeviceTranslation(change, projection) || !sameFootprintSize(oldFootprint, nextFootprint)) {
            pixelRevision++;
            options.cache.invalidate(candidate.key, "transform");
            mutableStats.transformFallbacks++;
            next.set(candidate.key, {
              candidate: { ...candidate, pixelRevision },
              fingerprints: nextFingerprints,
              pixelRevision,
              omitOnce: true,
              suppressed: false,
            });
            candidates.push({ ...candidate, pixelRevision });
            note("transform");
            continue;
          } else {
            mutableStats.translationReuses++;
          }
        }
      }
      const revised = { ...candidate, pixelRevision };
      candidates.push(revised);
      next.set(candidate.key, {
        candidate: revised,
        fingerprints: nextFingerprints,
        pixelRevision,
        omitOnce,
        suppressed: false,
      });
    }
    for (const key of previous.keys()) {
      if (!next.has(key)) {
        options.cache.invalidate(key, "topology");
        note("topology");
      }
    }
    states = next;
    candidatePlan = { ...provisional, candidates };
    pendingBuildFingerprint = {
      structuralRevision: list.structuralRevision,
      contentRevision: list.contentRevision,
    };
    mutableStats.plans++;
    mutableStats.considered += provisional.considered;
    mutableStats.selected = candidates.length;
    mutableStats.selectedPixels = provisional.selectedPixels;
    mutableStats.selectedBytes = provisional.selectedBytes;
    for (const reason of RETAINED_SUBTREE_REJECT_REASONS) {
      rejected[reason] += provisional.rejected[reason];
    }
  }

  function prepare(
    list: DrawList<ExecutorTexture | null>,
    projection: StageProjection,
    refresh: CompiledRefreshResult,
  ): RetainedRangeSubstitutionPlan | undefined {
    if (!options.enabled || disposed || candidatePlan === null || states.size === 0) return undefined;
    observeProjection(projection);
    const pairedFullBuild = refresh.rebuilt && pendingBuildFingerprint !== null &&
      pendingBuildFingerprint.structuralRevision === list.structuralRevision &&
      pendingBuildFingerprint.contentRevision === list.contentRevision &&
      refresh.contentRevision === list.contentRevision;
    // A planBuild immediately before this refresh already fingerprinted the
    // whole list. Every other rebuild (notably patch-journal overflow) has no
    // changed-command delta, so it must conservatively re-fingerprint ranges.
    const fingerprintAll = refresh.rebuilt && !pairedFullBuild;
    pendingBuildFingerprint = null;
    const changed = refresh.changedCommands;
    const candidates: RetainedSubtreeCandidate[] = [];
    for (const state of states.values()) {
      if (state.suppressed) continue;
      if (state.omitOnce) {
        state.omitOnce = false;
        mutableStats.liveFallbacks++;
        continue;
      }
      let touches = fingerprintAll;
      if (!touches) {
        for (const command of changed) {
          if (command >= state.candidate.start && command < state.candidate.end) {
            touches = true;
            break;
          }
        }
      }
      if (touches) {
        const nextFingerprints = fingerprints(list, state.candidate);
        const change = classifyFingerprints(state.fingerprints, nextFingerprints);
        const bounds = candidateBounds(list, state.candidate);
        if (bounds === null) {
          state.pixelRevision++;
          state.suppressed = true;
          state.fingerprints = nextFingerprints;
          options.cache.invalidate(state.candidate.key, "unknownBounds");
          mutableStats.transformFallbacks++;
          mutableStats.liveFallbacks++;
          note("transform");
          continue;
        }
        if (change.kind === "translation") {
          const oldFootprint = rasterFootprint(state.candidate.bounds, projection);
          const nextFootprint = rasterFootprint(bounds, projection);
          if (integerDeviceTranslation(change, projection) && sameFootprintSize(oldFootprint, nextFootprint)) {
            state.candidate = { ...state.candidate, bounds, pixelRevision: state.pixelRevision };
            state.fingerprints = nextFingerprints;
            mutableStats.translationReuses++;
          } else {
            state.pixelRevision++;
            state.candidate = { ...state.candidate, bounds, pixelRevision: state.pixelRevision };
            state.fingerprints = nextFingerprints;
            options.cache.invalidate(state.candidate.key, "transform");
            mutableStats.transformFallbacks++;
            mutableStats.liveFallbacks++;
            note("transform");
            continue;
          }
        } else if (change.kind !== "same") {
          state.pixelRevision++;
          state.candidate = { ...state.candidate, bounds, pixelRevision: state.pixelRevision };
          state.fingerprints = nextFingerprints;
          mutableStats.contentInvalidations++;
          note(change.kind === "clip" ? "clip" : change.kind === "transform" ? "transform" : "content");
          if (change.kind === "clip" || change.kind === "transform") {
            options.cache.invalidate(state.candidate.key, change.kind);
            mutableStats.transformFallbacks++;
            mutableStats.liveFallbacks++;
            continue;
          }
        }
      }
      candidates.push(state.candidate);
    }
    return candidates.length > 0
      ? options.cache.prepare(list, projection, candidates, refresh)
      : undefined;
  }

  function invalidateAll(reason: RetainedSubtreeInvalidationReason): void {
    if (disposed) return;
    note(reason);
    for (const state of states.values()) {
      state.pixelRevision++;
      state.candidate = { ...state.candidate, pixelRevision: state.pixelRevision };
    }
    if (reason === "resize" || reason === "rasterScale") options.cache.clear(reason);
    else options.cache.invalidateAll(reason);
    if (reason === "resize" || reason === "rasterScale") projectionKey = null;
  }

  function contextLost(): void {
    if (disposed) return;
    note("context");
    options.cache.invalidateContext();
  }

  return {
    enabled: options.enabled,
    get stats() { return mutableStats; },
    get candidatePlan() { return candidatePlan; },
    planBuild,
    prepare,
    invalidateAll,
    noteExecution(stats): void {
      execution.logicalCommands += stats.logicalCommands;
      execution.liveCommands += stats.liveCommands;
      execution.substitutedCommands += stats.substitutedCommands;
      execution.retainedComposites += stats.retainedComposites;
      execution.retainedRasterizations += stats.retainedRasterizations;
      execution.retainedFallbacks += stats.retainedFallbacks;
      execution.retainedRasterPixels += stats.retainedRasterPixels;
      execution.retainedCompositePixels += stats.retainedCompositePixels;
      execution.glyphRuns += stats.glyphRuns;
      execution.glyphDrawCalls += stats.glyphDrawCalls;
      execution.batches += stats.batches;
      execution.textureBinds += stats.textureBinds;
      execution.compiledGpuFullUploads += stats.compiledGpuFullUploads;
      execution.compiledGpuRangeUploads += stats.compiledGpuRangeUploads;
      execution.compiledGpuFullUploadBytes += stats.compiledGpuFullUploadBytes;
      execution.compiledGpuRangeUploadBytes += stats.compiledGpuRangeUploadBytes;
    },
    contextLost,
    dispose(): void {
      if (disposed) return;
      note("dispose");
      disposed = true;
      states.clear();
      candidatePlan = null;
      projectionKey = null;
      pendingBuildFingerprint = null;
      options.cache.dispose();
    },
  };
}
