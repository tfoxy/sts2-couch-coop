// THE EAGER-SCROLL TARGET SNAPSHOT — one copy, shared by both mirror backends.
//
// `eagerScroll.ts` owns the state machine (what the offset SHOULD be); this module owns the other half of the
// contract: WHICH nodes are scrollables, where their viewport is, how far the offset may travel, how much of a
// virtualized grid is actually materialized, and where the scrollbar strip is. Everything the engine reads off an
// {@link EagerScrollTarget} but the element, which is the backend's own (see EagerScrollTarget.el).
//
// WHY IT LIVES HERE, and not twice. The DOM walk grew this snapshot over four rounds, and four SEPARATELY EARNED
// bug fixes are folded into it — the painted-vs-streamed Y (R11: the map dipped 233px for a frame), the grid
// header merge (R11 §2: the first notch yanked a resting deck ~270px), the R20 on-stage scrollbar box (a phantom
// claim to the bar's left on a widened stage), and the wheel-safe gutter point (R11 WS-S §3). A second
// transcription for the canvas stage would be two chances to lose one of them, and the failure mode of losing one
// is a gesture that feels broken rather than a test that goes red.
//
// It is therefore a PURE function of plain data, on the `spreadLayout` / `viewScaleLayout` template:
//
//   * no DOM, no `window`, no module-level mutable state;
//   * the parts it cannot read off node data — where the backend actually PAINTED a node, whether a tween owns
//     its transform, whether this node even has a host to offset — arrive through {@link EagerScrollLayoutEnv},
//     which each backend implements over its own registries (the DOM's `records`, the canvas's captured globals
//     and tween loop).
//
// THE STRUCTURE SCAN IS CACHED BY THE CALLER, not here: a scrollable can only appear or disappear STRUCTURALLY,
// and each backend already has the signal for that (the `orderedIds` array identity). {@link scanEagerScrollIds}
// is the scan; {@link buildEagerScrollTargets} is the per-frame read, because the VALUES a target carries
// (`streamedY`, `renderedY`, `band`, `pinned`, the bar's `handleY`) change on every frame of a scroll.

import {
  MAP_LIMIT_HI,
  MAP_LIMIT_LO,
  type EagerScrollBarTarget,
  type EagerScrollBox,
  type EagerScrollTarget
} from "@/mirror/eagerScroll";
import type { MirrorNode } from "@/mirror/sceneTree";
import { designAabbOf } from "@/mirror/viewScaleLayout";

// The two scrollables the eager-scroll module drives locally (see eagerScroll.ts for WHY). Each is ONE Control
// whose local Y IS the scroll offset, with every scrolled thing as a descendant:
//   * `TheMap` under an `NMapScreen`  — the game's map container (paths, points, quill drawings, the marker);
//   * `ScrollContainer` under an `NCardGrid` (`card_grid.tscn`) — the deck / draw / discard / exhaust grids.
// Identified by (own name, parent node type): no scene-file suffix is available for either, because both are plain
// in-scene Controls that stream with no `sceneFilePath` of their own.
export const EAGER_MAP_CONTAINER = "TheMap";
export const EAGER_MAP_SCREEN_TYPE = "NMapScreen";
export const EAGER_GRID_CONTAINER = "ScrollContainer";
export const EAGER_GRID_TYPE = "NCardGrid";
export const EAGER_SCROLLBAR_NAME = "Scrollbar";
export const EAGER_SCROLLBAR_HANDLE = "Handle";
const EAGER_GRID_HOLDER_TYPE = "NGridCardHolder";

/** A single card row's pitch, for the degenerate one-materialized-row frame where the wire gives nothing to
 *  measure it from. One small card (the grid's own small-card scale) plus the grid's row padding. */
const EAGER_GRID_PITCH_FALLBACK = 400;

// Grid gutter sizing for layout and hit testing.
const EAGER_WHEEL_SAFE_MIN_GUTTER = 40;

/** One scrollable found by the structure scan. */
export interface EagerScrollCandidate {
  id: string;
  kind: "map" | "grid";
}

/**
 * Everything the snapshot cannot read off node data, supplied by whichever backend is painting.
 *
 * SCRATCH IS ALLOWED. `streamedGlobalOf` may return a buffer it reuses: every caller here consumes the array
 * before it asks for another one, which is what lets the canvas answer out of its own composition scratch instead
 * of allocating a 6-tuple per node per frame.
 */
export interface EagerScrollLayoutEnv {
  /** The scene's ids in wire order — what the structure scan walks. */
  orderedIds(): readonly string[];
  nodeById(id: string): MirrorNode | undefined;
  /** `id`'s children, or undefined when it has none. Order is the backend's; nothing here depends on it. */
  childIdsOf(id: string): readonly string[] | undefined;
  /** A node type's leaf name (the backend's own `nodeTypeLeaf`). */
  typeLeafOf(node: MirrorNode): string;
  /**
   * The node's GAME-space global transform — the DOM's `liftEndpointToGlobal(record, node.transform)`, the
   * canvas's own chain composition. Null when the backend has no placement for this node at all, which is the
   * gate that keeps a node the walk has never seen out of the snapshot.
   */
  streamedGlobalOf(id: string, node: MirrorNode): readonly number[] | null;
  /**
   * Has this node an actual paint HOST — something an offset could be written to? True for a built element on the
   * DOM path (a dormant record whose element was released answers false); always true for a node the canvas walk
   * can draw, which has no per-node host to lose.
   */
  hasHost(id: string): boolean;
  /** The node's cumulative wide-screen shift in design px (0 at 16:9). */
  spreadDxOf(id: string): number;
  /**
   * What the backend has actually PAINTED this node's parent-relative Y at, or `fallback` when it cannot say.
   * NOT the streamed value: node data lands the instant a delta is parsed while the paint is only written by the
   * backend's own frame, and composing the cosmetic offset against the fresher of the two is what made the map
   * dip 233px for a frame (see EagerScrollTarget.renderedY).
   */
  renderedYOf(id: string, fallback: number): number;
  /** Some ancestor is invisible — a closed screen still holds its whole subtree. */
  ancestorHidden(node: MirrorNode): boolean;
  /**
   * Something with a claim on this node's transform is driving it right now (a tween endpoint, a card flight):
   * its motion is the truth and a composed cosmetic offset would fight it, so the engine treats this as a HARD
   * RESET.
   */
  transformPinned(id: string): boolean;
  /** A map drawing tool is armed (the map must not scroll under a quill stroke). */
  drawingToolActive(): boolean;
}

/** Is this node one of the two scrollables, and which? Keyed on (own name, parent node type). */
export function eagerScrollKindOf(node: MirrorNode, env: EagerScrollLayoutEnv): "map" | "grid" | null {
  if (node.parentId == null) {
    return null;
  }
  if (node.name === EAGER_MAP_CONTAINER || node.name === EAGER_GRID_CONTAINER) {
    const parent = env.nodeById(node.parentId);
    if (!parent) {
      return null;
    }
    const parentLeaf = env.typeLeafOf(parent);
    if (node.name === EAGER_MAP_CONTAINER && parentLeaf === EAGER_MAP_SCREEN_TYPE) {
      return "map";
    }
    if (node.name === EAGER_GRID_CONTAINER && parentLeaf === EAGER_GRID_TYPE) {
      return "grid";
    }
  }
  return null;
}

/**
 * THE STRUCTURE SCAN. Cache this against the `orderedIds` array identity (both backends have it): a scrollable
 * can only appear or disappear when the tree does. Effective VISIBILITY is deliberately not tested here — a
 * screen hides by clearing `visible` on its root with no order change at all, so that half is re-checked live in
 * {@link buildEagerScrollTargets}.
 */
export function scanEagerScrollIds(env: EagerScrollLayoutEnv): EagerScrollCandidate[] {
  const found: EagerScrollCandidate[] = [];
  for (const id of env.orderedIds()) {
    const n = env.nodeById(id);
    if (!n) {
      continue;
    }
    const kind = eagerScrollKindOf(n, env);
    if (kind) {
      found.push({ id, kind });
    }
  }
  return found;
}

// A node's local Y — the quantity the game scrolls.
function eagerLocalY(node: MirrorNode): number { return node.transform ? node.transform[5] : 0; }

// The MATERIALIZED band of a virtualized card grid, in container-local Y: the extent covered by the card-holder
// rows the wire has actually sent. The grid keeps a BOUNDED pool of rows and recycles them as the offset moves, so
// scrolling eagerly past this band would reveal blank space no row has been recycled into yet. The holders
// themselves are boxless (0×0 Controls positioned at grid slots), so the band is their Y extent plus ONE row pitch
// of slack, measured from the pitch between distinct row Ys.
//
// R11 WS-S §2 — THE HEADER MERGE. The first row of a deck grid sits at local y≈348.8, well below the grid's own
// origin, because the `SortingOptions` header (a plain Control child, NOT a recycled holder) is streamed above it.
// Taking the band from the holders alone therefore declared the RESTING offset (0) illegal, and the first wheel
// notch yanked the content ~270px — the "works horribly" first impression. When the top materialized row is
// contiguous with that header (within one row pitch, which is true exactly when the grid is scrolled to the top —
// a row further down the list is a whole multiple of the pitch away from it) the band starts at 0.
function eagerGridBand(containerId: string, env: EagerScrollLayoutEnv): { lo: number; hi: number } | null {
  const kids = env.childIdsOf(containerId);
  if (!kids || kids.length === 0) {
    return null;
  }
  let lo = Infinity;
  let hi = -Infinity;
  const rowYs: number[] = [];
  const localY = (kn: MirrorNode): number => kn.transform![5];
  // Anything ABOVE the rows that the wire streams unconditionally (the sorting header) — the top of the content
  // the player can actually see at rest.
  let headerBottom = -Infinity;
  for (const kid of kids) {
    const kn = env.nodeById(kid);
    if (!kn || !kn.transform) {
      continue;
    }
    if (env.typeLeafOf(kn) !== EAGER_GRID_HOLDER_TYPE) {
      if (kn.visible && kn.localRect != null) {
        const bottom = localY(kn) + kn.localRect.height;
        if (bottom > headerBottom) headerBottom = bottom;
      }
      continue;
    }
    const y = localY(kn);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    if (!rowYs.some((v) => Math.abs(v - y) < 1)) {
      rowYs.push(y);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return null;
  }
  // Average row pitch (a single materialized row leaves nothing to measure — fall back to a nominal row).
  const pitch = rowYs.length > 1 ? (hi - lo) / (rowYs.length - 1) : EAGER_GRID_PITCH_FALLBACK;
  // The header merge (see above): the streamed header runs into the first materialized row, so the band covers
  // the content from its very top and the resting offset is legal.
  if (headerBottom > -Infinity && headerBottom < lo && lo - headerBottom <= pitch) {
    lo = 0;
  }
  return { lo, hi: hi + pitch };
}

// The grid's scrollbar: its own game-space BOX (the strip the eager engine must not claim — see
// EagerScrollTarget.scrollbarBox), that same strip's ON-STAGE box (see `scrollbarRenderedBox`), and its THUMB.
// Located by NAME under the OWNER (the `NCardGrid`) — the bar streams with no scene file of its own. Only while
// the bar is VISIBLE, which on the wire is exactly when it also carries a Stop mouse filter (the two move together).
function eagerScrollBar(
  ownerId: string,
  env: EagerScrollLayoutEnv
): { bar: EagerScrollBarTarget | null; box: EagerScrollBox | null; renderedBox: EagerScrollBox | null } {
  const kids = env.childIdsOf(ownerId);
  if (!kids) {
    return { bar: null, box: null, renderedBox: null };
  }
  for (const kid of kids) {
    const bar = env.nodeById(kid);
    if (!bar || bar.name !== EAGER_SCROLLBAR_NAME || !bar.visible) {
      continue;
    }
    let box: EagerScrollBox | null = null;
    let renderedBox: EagerScrollBox | null = null;
    const barGlobal = bar.transform != null && bar.localRect != null ? env.streamedGlobalOf(kid, bar) : null;
    if (barGlobal !== null && bar.localRect != null) {
      const aabb = designAabbOf(barGlobal, bar.localRect);
      box = { minX: aabb.x, minY: aabb.y, maxX: aabb.x + aabb.w, maxY: aabb.y + aabb.h };
      // R20 — the bar's ON-STAGE box in WIDENED-DESIGN space: the game rect shifted right by this node's own
      // cumulative `spreadDx`, exactly as the view-scale stamp's `renderedBox` is. The strip hugs the right edge
      // of an anchored 1920-wide frame, so on a widened stage it carries the FULL delta — the largest shift in
      // the dialog — and a game-space AABB test on the raw pointer therefore claims a band to its LEFT that
      // nothing paints. `dx === 0` on 16:9 ⇒ the two boxes are the same object.
      const dx = env.spreadDxOf(kid);
      renderedBox = dx === 0 ? box : { minX: box.minX + dx, minY: box.minY, maxX: box.maxX + dx, maxY: box.maxY };
    }
    const handleIds = env.childIdsOf(kid);
    for (const hid of handleIds ?? []) {
      const handle = env.nodeById(hid);
      if (!handle || handle.name !== EAGER_SCROLLBAR_HANDLE || !handle.transform || !env.hasHost(hid)) {
        continue;
      }
      return { bar: { id: hid, handleY: eagerLocalY(handle) }, box, renderedBox };
    }
    return { bar: null, box, renderedBox };
  }
  return { bar: null, box: null, renderedBox: null };
}

// The middle of a card grid's left gutter
// between the grid's own frame and its ScrollContainer (x≈87 on a deck view, whose content starts at 175), at the
// frame's vertical middle — deliberately the centre of the strip rather than either end, where a screen's Back
// button / bottom bar can reach into it. The grid's own input handler covers the whole frame, so the tick still
// scrolls. Null when there is no gutter to aim at; the caller then sends at the pointer.
function eagerWheelSafePoint(viewport: EagerScrollBox, contentLeft: number): { x: number; y: number } | null {
  const gutter = contentLeft - viewport.minX;
  if (!(gutter >= EAGER_WHEEL_SAFE_MIN_GUTTER)) {
    return null;
  }
  return { x: viewport.minX + gutter / 2, y: (viewport.minY + viewport.maxY) / 2 };
}

/**
 * THE PER-FRAME SNAPSHOT: one {@link EagerScrollTarget} per live scrollable, in `candidates` order (which is
 * paint order, so the engine's "last viewport match wins" rule picks the topmost).
 *
 * `el` is deliberately NOT set — a backend that has one attaches it to the returned targets (see
 * EagerScrollTarget.el; it is read only by the engine's pre-seam fallback).
 */
export function buildEagerScrollTargets(
  candidates: readonly EagerScrollCandidate[],
  env: EagerScrollLayoutEnv
): EagerScrollTarget[] {
  const out: EagerScrollTarget[] = [];
  for (const candidate of candidates) {
    const node = env.nodeById(candidate.id);
    if (!node || !env.hasHost(candidate.id) || !node.visible || node.transform == null || node.localRect == null) {
      continue;
    }
    if (env.ancestorHidden(node)) {
      continue; // a closed screen still holds its whole subtree — it must not claim a pointer or a wheel tick
    }
    const ownerId = node.parentId;
    const owner = ownerId != null ? env.nodeById(ownerId) : undefined;
    if (!owner || ownerId == null || owner.transform == null || owner.localRect == null) {
      continue;
    }
    const ownerGlobal = env.streamedGlobalOf(ownerId, owner);
    if (ownerGlobal === null) {
      continue;
    }
    const ownerBox = designAabbOf(ownerGlobal, owner.localRect);
    const viewport = {
      minX: ownerBox.x,
      minY: ownerBox.y,
      maxX: ownerBox.x + ownerBox.w,
      maxY: ownerBox.y + ownerBox.h
    };
    const streamedY = eagerLocalY(node);
    let limitLo: number;
    let limitHi: number;
    let band: { lo: number; hi: number } | null = null;
    let wheelSafe: { x: number; y: number } | null = null;
    if (candidate.kind === "map") {
      // The map screen's own scroll limits (the elastic window its drag target is pulled back into). The whole
      // map is streamed, so there is no virtualization band.
      limitLo = MAP_LIMIT_LO;
      limitHi = MAP_LIMIT_HI;
    } else {
      // The card grid's own scroll limits: the container is sized to the FULL content, so the travel is
      // content − viewport, upward only.
      const contentH = node.localRect.height;
      const viewH = ownerBox.h;
      if (contentH <= viewH) {
        limitLo = streamedY;
        limitHi = streamedY; // nothing to scroll — never invent travel the game would refuse
      } else {
        limitLo = viewH - contentH;
        limitHi = 0;
      }
      band = eagerGridBand(candidate.id, env);
      // The content's own left edge in game space — the gutter the wheel aims at starts there.
      const contentGlobal = env.streamedGlobalOf(candidate.id, node);
      wheelSafe =
        contentGlobal === null ? null : eagerWheelSafePoint(viewport, designAabbOf(contentGlobal, node.localRect).x);
    }
    const scrollbar =
      candidate.kind === "grid" ? eagerScrollBar(ownerId, env) : { bar: null, box: null, renderedBox: null };
    out.push({
      id: candidate.id,
      kind: candidate.kind,
      streamedY,
      renderedY: env.renderedYOf(candidate.id, streamedY),
      viewport,
      scrollbarBox: scrollbar.box,
      scrollbarRenderedBox: scrollbar.renderedBox,
      wheelSafe,
      limitLo,
      limitHi,
      band,
      // A transform tween owns the container (an act-change slide, a dialog open): its endpoint is the truth and a
      // composed cosmetic translate would fight it — the eager module treats this as a HARD RESET.
      pinned: env.transformPinned(candidate.id),
      // R11 WS-S §7: the map does not scroll while a drawing tool is armed. The armed state is the ONE accessor
      // WS-M established (the tool button's Icon glow texture), asked only for the map.
      suppressed: candidate.kind === "map" && env.drawingToolActive(),
      bar: scrollbar.bar
    });
  }
  return out;
}
