import type { DrawListBuild } from "@/mirror/canvas/buildDrawList";
import { REMOTE_FOLLOWER_TYPES } from "@/mirror/renderer/interactionPolicy";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";
import { isPureTranslation } from "./retainedComposition";

/** What a moved-span refusal reads from the committed build. */
export type TranslatedSpanBuild = Pick<DrawListBuild, "order" | "viewScaleCandidates" | "viewScaleStamps" | "clipRanges">;

export interface TranslatedSpanContext {
  readonly build: TranslatedSpanBuild;
  readonly nodes: ReadonlyMap<string, MirrorNode>;
  /** The committed build's stretch factor; 1 when the stage is not widened. */
  readonly spreadFactor: number;
  /** The committed build's spread field claims (mode 1 or 2) by node; absent means a ride (mode 0). */
  readonly fieldModes: ReadonlyMap<string, number>;
  /** The committed build's nodes drawn with a nonzero spread shift. */
  readonly shifted: ReadonlySet<string>;
  /** The executor can move a clip rect by the same vector (`rustOffsetPatch` with a clip-translating executor). */
  readonly clipsMovable: boolean;
  /** Told the node a `wire-spread` refusal tripped on, for the decline-type diagnostics. */
  readonly blame?: (id: string) => void;
}

/**
 * Why re-posing `rootId`'s whole paint-order span by the streamed game-space `delta` (left-multiplied onto every
 * drawn pose) would not draw what a full build draws, or null when it would.
 *
 * - `wire-view-scale`: a view-scale stamp is measured where its node is drawn, and a stamp above the root scales
 *   the drawn step, so a stamped or candidate node in the span, or above it, is refused.
 * - `wire-clip`: a clip rect is baked from its clipper's drawn box; only an executor that can translate one may
 *   carry a clipper in the span (and only for a pure translation, which the caller checks).
 * - `wire-spread`, on a widened stage only:
 *   - a field claim (mode 1 or 2) is a function of the node's own game X, so it refuses a delta that is not a pure
 *     translation or that moves X (a Y-only or identity translation leaves every claim as it was);
 *   - a remote follower reads the content under its game point, X and Y, so it refuses any delta;
 *   - a node drawn at a spread shift `s` is drawn `T(s)·g`; a rebuild draws `T(s)·D·g` where the patch draws
 *     `D·T(s)·g`, which agree only for a pure translation `D`.
 *   A ride (mode 0) takes an ancestor's shift; with no claimer in the span, every ride reads an ancestor outside
 *   it, which did not move.
 *   `rustWireSpreadPatch` re-poses such spans node by node instead (`wireSpreadPlan.ts`) and calls this with a
 *   spread factor of 1, keeping only the view-scale and clip refusals.
 */
export function translatedSpanRefusal(rootId: string, delta: ArrayLike<number>, context: TranslatedSpanContext): string | null {
  const { build, nodes } = context;
  const span = build.order.entries.get(rootId);
  if (!span) return "wire-missing-span";
  const pure = isPureTranslation(delta);
  const movesX = !pure || delta[4] !== 0;
  const moves = movesX || delta[5] !== 0;
  // Nothing moves: the drawn picture is already the rebuilt one.
  if (!moves) return null;
  const stamped = (id: string) => build.viewScaleCandidates.has(id) || build.viewScaleStamps.has(id);
  for (let up = nodes.get(rootId)?.parentId; up != null; up = nodes.get(up)?.parentId)
    if (stamped(up)) return "wire-view-scale";
  const widened = context.spreadFactor !== 1;
  for (let order = span.spanStart; order < span.spanEnd; order++) {
    const id = build.order.ids[order];
    if (stamped(id)) return "wire-view-scale";
    if (!context.clipsMovable && build.clipRanges.has(id)) return "wire-clip";
    if (!widened) continue;
    const node = nodes.get(id);
    if ((movesX && (context.fieldModes.get(id) ?? 0) !== 0) || (!pure && context.shifted.has(id)) ||
      (node && REMOTE_FOLLOWER_TYPES.has(nodeTypeLeaf(node.nodeType)))) {
      context.blame?.(id);
      return "wire-spread";
    }
  }
  return null;
}
