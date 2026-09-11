// WIRE-DELTA ADMISSION FOR THE CURRENT CANVAS DRAW LIST.
//
// applySceneDelta always replaces a changed node (and its changed nested wire
// values) before CanvasMirrorRenderer receives reconcile(). That lets this
// graph hold the previous node reference and compare only changedIds. There
// is deliberately no stringify, clone, sort or full-scene scan on this path.

import { streamedAlphasOf, type NodeCommandRange, type StreamedAlphas } from "@/mirror/canvas/buildDrawList";
import type { MirrorColor, MirrorNode, MirrorRect, MirrorState } from "@/mirror/sceneTree";

export type WireDeltaBuildCause = "cold" | "structural" | "broad" | "unknown" | "transform" | "content";

export interface WireNodeSnapshot {
  node: MirrorNode;
  range: NodeCommandRange | null;
  mod: number;
  self: number;
  /** Child membership as it was when the builder emitted this node. */
  childIds: readonly string[];
  /**
   * The non-patchable render identity from the completed walk. This is not a
   * hash (hashing every wire object would buy nothing); it is the reference
   * snapshot against which the changed-node comparator below proves that only
   * one of the explicitly admitted channels moved.
   */
  renderIdentity: MirrorNode;
}

export interface WireDeltaGraph {
  readonly nodes: ReadonlyMap<string, WireNodeSnapshot>;
  readonly orderedIds: readonly string[];
}

/** All buffers are renderer-owned and reused for every coalesced wire drain. */
export interface WireDeltaScratch {
  sourceIds: string[];
  opacityIds: string[];
  transformIds: string[];
  changedIds: string[];
  opacityRoots: Set<string>;
  alpha: StreamedAlphas;
  plan: WireDeltaPlan;
}

/** Mutable, caller-owned result. Its arrays/sets always belong to the scratch. */
export interface WireDeltaPlan {
  mode: "direct" | "full";
  cause: WireDeltaBuildCause | null;
  sourceIds: readonly string[];
  opacityIds: readonly string[];
  transformIds: readonly string[];
  changedIds: readonly string[];
  opacityRoots: ReadonlySet<string>;
  nodesVisited: number;
}

const PATCH_KEYS: Record<string, true | undefined> = {
  transform: true,
  textureUrl: true,
  textureRegion: true,
  opacity: true,
  modulate: true,
  selfModulate: true
};

// Keep this explicit so a new wire field never becomes silently direct-patchable.
const KNOWN_NODE_KEYS: Record<string, true | undefined> = Object.fromEntries([
  "id", "parentId", "name", "nodeType", "showBehindParent", "clipChildren", "clipContents", "ninePatchMargins", "font",
  "richBoldFont", "richItalicFont", "richBoldItalicFont", "richBoldFontSizePx", "richItalicFontSizePx", "richBoldItalicFontSizePx",
  "richBoldFontSpacingPx", "richItalicFontSpacingPx", "richBoldItalicFontSpacingPx", "textWrap", "shadow", "richText", "shaderId",
  "materialRef", "shaderParams", "textureStretchMode", "textureFlipH", "textureFlipV", "canvasBlendMode", "particleSpec",
  "particleEmitting", "particleRestartEpoch", "spineSceneResPath", "spineNodePath", "spineAnimations", "spineSkelResPath",
  "sceneFilePath", "mouseFilter", "anchorLeft", "anchorRight", "anchorOwnerId", "containerLayout", "contentKey", "spineCurrentAnim",
  "spineSkin", "spineMat", "spinePaused", "spineTrackTime", "spineLooping", "pinnedLoopAnim", "outline", "transform", "localRect",
  "rect", "visible", "focused", "opacity", "rotation", "scaleX", "scaleY", "pivotX", "pivotY", "zIndex", "textureUrl", "textureRegion",
  "textureMargin", "ninePatch", "modulate", "selfModulate", "fillColor", "range", "text", "intentFrames", "linePoints", "lineWidth", "lineColor"
].map((key) => [key, true]));

function rectEqual(a: MirrorRect | null, b: MirrorRect | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

function matrixEqual(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function colorRgbEqual(a: MirrorColor | null, b: MirrorColor | null): boolean {
  return a === b || (a !== null && b !== null && a.r === b.r && a.g === b.g && a.b === b.b);
}

/** JSON-shaped wire values, compared without allocating key arrays or clones. */
function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) return false;
  if (arrayA) {
    const left = a as unknown[];
    const right = b as unknown[];
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (!valueEqual(left[index], right[index])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key in left) {
    if (!(key in right) || !valueEqual(left[key], right[key])) return false;
  }
  for (const key in right) if (!(key in left)) return false;
  return true;
}

/** Recursive value comparison for normalized JSON-shaped wire fields; no clones or key arrays. */
function equalOutsidePatchChannels(previous: MirrorNode, next: MirrorNode): boolean {
  const oldRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const key in oldRecord) {
    if (KNOWN_NODE_KEYS[key] !== true || (PATCH_KEYS[key] !== true && !valueEqual(oldRecord[key], nextRecord[key]))) return false;
  }
  // Reject future producer fields rather than accepting an unmodelled channel.
  for (const key in nextRecord) {
    if (KNOWN_NODE_KEYS[key] !== true || (PATCH_KEYS[key] !== true && !(key in oldRecord))) return false;
  }
  return colorRgbEqual(previous.modulate, next.modulate) && colorRgbEqual(previous.selfModulate, next.selfModulate);
}

export function createWireDeltaScratch(): WireDeltaScratch {
  const sourceIds: string[] = [];
  const opacityIds: string[] = [];
  const transformIds: string[] = [];
  const changedIds: string[] = [];
  const opacityRoots = new Set<string>();
  return {
    sourceIds,
    opacityIds,
    transformIds,
    changedIds,
    opacityRoots,
    alpha: { mod: 1, self: 1 },
    plan: { mode: "full", cause: "cold", sourceIds, opacityIds, transformIds, changedIds, opacityRoots, nodesVisited: 0 }
  };
}

/** One O(scene) capture after a completed builder walk; node values themselves are not copied. */
export function captureWireDeltaGraph(state: MirrorState, ranges: ReadonlyMap<string, NodeCommandRange>): WireDeltaGraph {
  const nodes = new Map<string, WireNodeSnapshot>();
  const children = new Map<string, string[]>();
  // This runs beside a completed full builder, never in the wire hot path.
  // Keeping exact child membership lets the patch admission reject a local
  // transform whose descendants would inherit a different matrix.
  for (const [id, node] of state.nodes) {
    if (node.parentId !== null && state.nodes.has(node.parentId)) {
      const ids = children.get(node.parentId) ?? [];
      ids.push(id);
      children.set(node.parentId, ids);
    }
  }
  const alpha: StreamedAlphas = { mod: 1, self: 1 };
  for (const [id, node] of state.nodes) {
    streamedAlphasOf(node, alpha);
    nodes.set(id, {
      node,
      range: ranges.get(id) ?? null,
      mod: alpha.mod,
      self: alpha.self,
      childIds: Object.freeze(children.get(id) ?? []),
      renderIdentity: node
    });
  }
  return { nodes, orderedIds: state.orderedIds };
}

/** Update only admitted changed snapshots after their list commands were atomically applied. */
export function commitWireDelta(graph: WireDeltaGraph, state: MirrorState, ids: readonly string[], scratch: WireDeltaScratch): void {
  const nodes = graph.nodes as Map<string, WireNodeSnapshot>;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    const snapshot = nodes.get(id);
    const node = state.nodes.get(id);
    if (!snapshot || !node) throw new Error(`cannot commit uncached wire node ${id}`);
    snapshot.node = node;
    snapshot.renderIdentity = node;
    streamedAlphasOf(node, scratch.alpha);
    snapshot.mod = scratch.alpha.mod;
    snapshot.self = scratch.alpha.self;
  }
}

function finishFull(plan: WireDeltaPlan, cause: WireDeltaBuildCause, nodesVisited: number): WireDeltaPlan {
  plan.mode = "full";
  plan.cause = cause;
  plan.nodesVisited = nodesVisited;
  return plan;
}

/** Admit only source/UV and opacity deltas; every other channel takes the existing full builder. */
export function planWireDelta(previous: WireDeltaGraph | null, state: MirrorState, changedIds: ReadonlySet<string>, structural: boolean, scratch: WireDeltaScratch): WireDeltaPlan {
  scratch.sourceIds.length = 0;
  scratch.opacityIds.length = 0;
  scratch.transformIds.length = 0;
  scratch.changedIds.length = 0;
  scratch.opacityRoots.clear();
  const plan = scratch.plan;
  if (previous === null) return finishFull(plan, "cold", 0);
  if (structural || state.sceneRewrite || previous.orderedIds !== state.orderedIds) return finishFull(plan, "structural", 0);
  if (previous.nodes.size !== state.nodes.size || changedIds.size === 0) return finishFull(plan, changedIds.size === 0 ? "broad" : "structural", 0);

  let nodesVisited = 0;
  for (const id of changedIds) {
    nodesVisited++;
    const snapshot = previous.nodes.get(id);
    const node = state.nodes.get(id);
    if (!snapshot || !node) return finishFull(plan, "unknown", nodesVisited);
    const old = snapshot.renderIdentity;
    if (old.parentId !== node.parentId) return finishFull(plan, "structural", nodesVisited);
    if (!equalOutsidePatchChannels(old, node)) return finishFull(plan, "content", nodesVisited);
    const transformChanged = !matrixEqual(old.transform, node.transform);
    const sourceChanged = old.textureUrl !== node.textureUrl || !rectEqual(old.textureRegion, node.textureRegion);
    streamedAlphasOf(node, scratch.alpha);
    const opacityChanged = snapshot.mod !== scratch.alpha.mod || snapshot.self !== scratch.alpha.self;
    if (sourceChanged) scratch.sourceIds.push(id);
    if (opacityChanged) {
      scratch.opacityIds.push(id);
      scratch.opacityRoots.add(id);
    }
    if (transformChanged) scratch.transformIds.push(id);
    if (sourceChanged || opacityChanged || transformChanged) scratch.changedIds.push(id);
  }
  if (scratch.changedIds.length === 0) return finishFull(plan, "broad", nodesVisited);
  plan.mode = "direct";
  plan.cause = null;
  plan.nodesVisited = nodesVisited;
  return plan;
}
