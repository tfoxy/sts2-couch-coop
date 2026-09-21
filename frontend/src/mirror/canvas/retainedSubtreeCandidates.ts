import {
  BLEND_MIX,
  commandDamageBounds,
  createDamageRect,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_QUAD,
  RETAINED_RANGE_DEFAULTS,
  transformDamageRect,
  unionDamageRect,
  type DamageRect,
  type DrawList,
  type RetainedRangeCandidate,
  type StageProjection,
} from "@godot-scene-web/canvas";

import type { DrawListBuild } from "@/mirror/canvas/buildDrawList";

export const RETAINED_SUBTREE_MAX_ENTRIES = RETAINED_RANGE_DEFAULTS.maxEntries;
export const RETAINED_SUBTREE_MAX_DIMENSION = RETAINED_RANGE_DEFAULTS.maxDimension;
export const RETAINED_SUBTREE_MAX_ENTRY_AREA_FRACTION = RETAINED_RANGE_DEFAULTS.maxEntryStageAreaRatio;
export const RETAINED_SUBTREE_MAX_FRAME_AREA_FRACTION = RETAINED_RANGE_DEFAULTS.maxCompositeStageAreaRatio;
export const RETAINED_SUBTREE_RESIDENT_BYTES = RETAINED_RANGE_DEFAULTS.maxResidentBytes;
export const RETAINED_SUBTREE_PEAK_BYTES = RETAINED_RANGE_DEFAULTS.maxPeakBytes;
export const RETAINED_SUBTREE_GUTTER_PX = RETAINED_RANGE_DEFAULTS.gutterPixels;
export const RETAINED_SUBTREE_STALE_FRAMES = RETAINED_RANGE_DEFAULTS.maxUnseenFrames;

export type RetainedSubtreeRejectReason =
  | "empty"
  | "interleaved"
  | "externalClip"
  | "unbalancedClip"
  | "unsafeCommand"
  | "unsafeBlend"
  | "unknownBounds"
  | "dynamicSurface"
  | "tooLittleWork"
  | "emptyPixels"
  | "dimension"
  | "entryArea"
  | "overlap"
  | "frameArea"
  | "residentBytes"
  | "replacementBytes";

export interface RetainedSubtreeCandidate extends RetainedRangeCandidate {
  readonly ownerId: string;
  readonly ownerOrder: number;
  /** Ordered subtree ids and parent edges, independent of command payload/indexes. */
  readonly ownershipKey: string;
  readonly commandCount: number;
  readonly paintCommands: number;
  readonly glyphRuns: number;
  readonly texturedPrimitives: number;
  readonly weightedWork: number;
  readonly pixelArea: number;
  readonly bytes: number;
}

export interface RetainedSubtreeCandidatePlan {
  readonly structuralRevision: number;
  readonly contentRevision: number;
  readonly candidates: readonly RetainedSubtreeCandidate[];
  readonly rejected: Readonly<Record<RetainedSubtreeRejectReason, number>>;
  readonly considered: number;
  readonly selectedPixels: number;
  readonly selectedBytes: number;
}

interface CandidateDraft extends RetainedSubtreeCandidate {
  readonly score: number;
}

interface OwnershipAggregate {
  start: number;
  end: number;
  dynamic: boolean;
}

export const RETAINED_SUBTREE_REJECT_REASONS: readonly RetainedSubtreeRejectReason[] = [
  "empty",
  "interleaved",
  "externalClip",
  "unbalancedClip",
  "unsafeCommand",
  "unsafeBlend",
  "unknownBounds",
  "dynamicSurface",
  "tooLittleWork",
  "emptyPixels",
  "dimension",
  "entryArea",
  "overlap",
  "frameArea",
  "residentBytes",
  "replacementBytes",
];

function emptyRejects(): Record<RetainedSubtreeRejectReason, number> {
  return Object.fromEntries(RETAINED_SUBTREE_REJECT_REASONS.map((reason) => [reason, 0])) as Record<
    RetainedSubtreeRejectReason,
    number
  >;
}

function intersects(a: Pick<RetainedSubtreeCandidate, "start" | "end">, b: Pick<RetainedSubtreeCandidate, "start" | "end">): boolean {
  return a.start < b.end && b.start < a.end;
}

function deviceBounds(
  bounds: DamageRect,
  projection: StageProjection,
  out: DamageRect,
): DamageRect | null {
  transformDamageRect(bounds, projection.toFramebuffer, out);
  // Match GSW's allocation exactly. Retained ranges are rasterized from their
  // complete unclipped bounds, including pixels outside the stage; clamping
  // here would under-price the FBO that the cache actually has to allocate.
  const minX = Math.floor(out.x) - RETAINED_SUBTREE_GUTTER_PX;
  const minY = Math.floor(out.y) - RETAINED_SUBTREE_GUTTER_PX;
  const maxX = Math.ceil(out.x + out.width) + RETAINED_SUBTREE_GUTTER_PX;
  const maxY = Math.ceil(out.y + out.height) + RETAINED_SUBTREE_GUTTER_PX;
  out.x = minX;
  out.y = minY;
  out.width = Math.max(0, maxX - minX);
  out.height = Math.max(0, maxY - minY);
  return out.width > 0 && out.height > 0 ? out : null;
}

/**
 * Derive independently replayable ranges from the actual painter ownership.
 *
 * A PaintOrder subtree is contiguous in NODE space. This pass proves the
 * stronger command-space property rather than assuming it: every command in
 * the selected interval must belong to one of those nodes, including only the
 * clip push/pop that the builder recorded for that owner. Runtime insertions
 * are therefore eligible only when they landed in a real node range.
 */
export function planRetainedSubtreeCandidates<TTexture>(
  build: DrawListBuild,
  list: DrawList<TTexture>,
  projection: StageProjection,
  pixelRevision = 0,
): RetainedSubtreeCandidatePlan {
  const rejected = emptyRejects();
  const drafts: CandidateDraft[] = [];
  const commandOwner = new Int32Array(list.count);
  const boundsScratch = createDamageRect();
  const unionScratch = createDamageRect();
  const pixelScratch = createDamageRect();
  const stageArea = projection.framebufferWidth * projection.framebufferHeight;
  const entries = [...build.order.entries.values()];
  const ownership = new Map<string, OwnershipAggregate>();
  const clipDepth = new Int32Array(list.count + 1);
  const paintPrefix = new Uint32Array(list.count + 1);
  const glyphPrefix = new Uint32Array(list.count + 1);
  const texturedPrefix = new Uint32Array(list.count + 1);

  const markOwned = (command: number, ownerOrder: number): void => {
    if (command < 0 || command >= commandOwner.length) return;
    const encoded = ownerOrder + 1;
    commandOwner[command] = commandOwner[command] === 0 ? encoded : -1;
  };
  for (const entry of entries) {
    const aggregate: OwnershipAggregate = {
      start: list.count,
      end: 0,
      dynamic:
        build.fxQuadIds.has(entry.id) ||
        build.spineQuadIds.has(entry.id) ||
        build.trailQuadIds.has(entry.id),
    };
    const range = build.ranges.get(entry.id);
    if (range !== undefined) {
      aggregate.start = Math.min(aggregate.start, range.start);
      aggregate.end = Math.max(aggregate.end, range.paintEnd);
      for (let command = range.start; command < range.paintEnd; command++) markOwned(command, entry.order);
    }
    const clip = build.clipRanges.get(entry.id);
    if (clip !== undefined) {
      aggregate.start = Math.min(aggregate.start, clip.push);
      aggregate.end = Math.max(aggregate.end, clip.pop + 1);
      markOwned(clip.push, entry.order);
      markOwned(clip.pop, entry.order);
    }
    ownership.set(entry.id, aggregate);
  }
  // Fold child ownership into parents once. This replaces a subtree slice and
  // range walk per candidate with one topology pass per full build.
  for (const entry of [...entries].sort((a, b) => b.depth - a.depth || b.order - a.order)) {
    if (entry.parentId === null) continue;
    const child = ownership.get(entry.id);
    const parent = ownership.get(entry.parentId);
    if (child === undefined || parent === undefined) continue;
    parent.start = Math.min(parent.start, child.start);
    parent.end = Math.max(parent.end, child.end);
    parent.dynamic ||= child.dynamic;
  }

  let depth = 0;
  for (let command = 0; command < list.count; command++) {
    clipDepth[command] = depth;
    const kind = list.kindAt(command);
    if (kind === DRAW_CLIP_PUSH) depth++;
    else if (kind === DRAW_CLIP_POP) depth--;
    paintPrefix[command + 1] = paintPrefix[command] + (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH || kind === DRAW_GLYPHS ? 1 : 0);
    glyphPrefix[command + 1] = glyphPrefix[command] + (kind === DRAW_GLYPHS ? 1 : 0);
    texturedPrefix[command + 1] = texturedPrefix[command] + (
      (kind === DRAW_QUAD || kind === DRAW_NINE_PATCH) && list.textureAt(command) !== null ? 1 : 0
    );
  }
  clipDepth[list.count] = depth;

  for (const entry of entries) {
    const aggregate = ownership.get(entry.id)!;
    const { start, end } = aggregate;

    if (start >= end) {
      rejected.empty++;
      continue;
    }
    if (aggregate.dynamic) {
      rejected.dynamicSurface++;
      continue;
    }
    if (clipDepth[start] !== 0) {
      rejected.externalClip++;
      continue;
    }
    const roughPaint = paintPrefix[end] - paintPrefix[start];
    const roughGlyphs = glyphPrefix[end] - glyphPrefix[start];
    const roughTextures = texturedPrefix[end] - texturedPrefix[start];
    if (roughPaint < 8 || (roughGlyphs < 2 && roughTextures < 8)) {
      rejected.tooLittleWork++;
      continue;
    }

    let intervalDepth = 0;
    let glyphRuns = 0;
    let texturedPrimitives = 0;
    let paintCommands = 0;
    let weightedWork = 0;
    let haveBounds = false;
    let reject: RetainedSubtreeRejectReason | null = null;
    const bounds: DamageRect = { x: 0, y: 0, width: 0, height: 0 };
    for (let command = start; command < end; command++) {
      const ownerOrder = commandOwner[command] - 1;
      if (ownerOrder < entry.spanStart || ownerOrder >= entry.spanEnd) {
        reject = "interleaved";
        break;
      }
      const kind = list.kindAt(command);
      if (kind === DRAW_CLIP_PUSH) {
        intervalDepth++;
        continue;
      }
      if (kind === DRAW_CLIP_POP) {
        intervalDepth--;
        if (intervalDepth < 0) reject = "unbalancedClip";
        continue;
      }
      if (kind !== DRAW_QUAD && kind !== DRAW_NINE_PATCH && kind !== DRAW_GLYPHS) {
        reject = "unsafeCommand";
        break;
      }
      paintCommands++;
      if (kind === DRAW_GLYPHS) {
        glyphRuns++;
        weightedWork += 8;
      } else {
        const intsAt = list.intOffsetAt(command);
        if (list.ints[intsAt] !== BLEND_MIX) {
          reject = "unsafeBlend";
          break;
        }
        weightedWork++;
        if (list.textureAt(command) !== null) texturedPrimitives++;
      }
      const commandBounds = commandDamageBounds(list, command, boundsScratch);
      if (commandBounds === null) {
        reject = "unknownBounds";
        break;
      }
      if (!haveBounds) {
        bounds.x = commandBounds.x;
        bounds.y = commandBounds.y;
        bounds.width = commandBounds.width;
        bounds.height = commandBounds.height;
        haveBounds = true;
      } else {
        unionDamageRect(bounds, commandBounds, unionScratch);
        bounds.x = unionScratch.x;
        bounds.y = unionScratch.y;
        bounds.width = unionScratch.width;
        bounds.height = unionScratch.height;
      }
    }
    if (reject !== null) {
      rejected[reject]++;
      continue;
    }
    if (intervalDepth !== 0) {
      rejected.unbalancedClip++;
      continue;
    }
    if (paintCommands < 8 || (glyphRuns < 2 && texturedPrimitives < 8)) {
      rejected.tooLittleWork++;
      continue;
    }
    if (!haveBounds || deviceBounds(bounds, projection, pixelScratch) === null) {
      rejected.emptyPixels++;
      continue;
    }
    const pixelWidth = pixelScratch.width;
    const pixelHeight = pixelScratch.height;
    const pixelArea = pixelWidth * pixelHeight;
    if (pixelWidth > RETAINED_SUBTREE_MAX_DIMENSION || pixelHeight > RETAINED_SUBTREE_MAX_DIMENSION) {
      rejected.dimension++;
      continue;
    }
    if (stageArea <= 0 || pixelArea > stageArea * RETAINED_SUBTREE_MAX_ENTRY_AREA_FRACTION) {
      rejected.entryArea++;
      continue;
    }
    const bytes = pixelArea * 4;
    drafts.push({
      key: entry.id,
      ownerId: entry.id,
      ownerOrder: entry.order,
      ownershipKey: JSON.stringify(
        build.order.ids.slice(entry.spanStart, entry.spanEnd).map((id) => [
          id,
          build.order.entries.get(id)?.parentId ?? null,
        ]),
      ),
      start,
      end,
      bounds: { ...bounds },
      pixelRevision,
      commandCount: end - start,
      paintCommands,
      glyphRuns,
      texturedPrimitives,
      weightedWork,
      pixelArea,
      bytes,
      score: weightedWork / Math.max(1, pixelArea),
    });
  }

  drafts.sort((a, b) => b.score - a.score || a.ownerOrder - b.ownerOrder || a.key.localeCompare(b.key));
  const selected: CandidateDraft[] = [];
  let selectedPixels = 0;
  let selectedBytes = 0;
  let largestBytes = 0;
  for (const draft of drafts) {
    if (selected.length >= RETAINED_SUBTREE_MAX_ENTRIES) break;
    if (selected.some((candidate) => intersects(candidate, draft))) {
      rejected.overlap++;
      continue;
    }
    if (selectedPixels + draft.pixelArea > stageArea * RETAINED_SUBTREE_MAX_FRAME_AREA_FRACTION) {
      rejected.frameArea++;
      continue;
    }
    if (selectedBytes + draft.bytes > RETAINED_SUBTREE_RESIDENT_BYTES) {
      rejected.residentBytes++;
      continue;
    }
    const nextLargest = Math.max(largestBytes, draft.bytes);
    if (selectedBytes + draft.bytes + nextLargest > RETAINED_SUBTREE_PEAK_BYTES) {
      rejected.replacementBytes++;
      continue;
    }
    selected.push(draft);
    selectedPixels += draft.pixelArea;
    selectedBytes += draft.bytes;
    largestBytes = nextLargest;
  }

  selected.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  return {
    structuralRevision: list.structuralRevision,
    contentRevision: list.contentRevision,
    candidates: selected,
    rejected,
    considered: build.order.entries.size,
    selectedPixels,
    selectedBytes,
  };
}
