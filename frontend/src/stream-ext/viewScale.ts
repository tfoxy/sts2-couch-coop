// stream-ext/viewScale.ts — the render-stream client's READABILITY-SCALING module (TAG3).
//
// The old mirror's `uiScaling` table (`mirror/viewScale.ts`), applied as `scaleAbout` overrides instead of DOM
// block-scale / font-size changes: **no text reflow** (the user's Q3 answer). Each widget the table enlarges is scaled
// as one rigid subtree about its authored anchor, so labels grow and may overlap neighbours rather than re-laying out.
// The table is matched over `(scene, path)`; the three leaf-detected entries (card-reward screen group + per-card,
// the treasure relic holder) arrive as the mod's groups because scene + path are not enough for them.
//
// DIRTY ONLY. The desired overrides are static once the identity table is known (the table does not depend on the
// frame's transforms, only on the rects the stamp reads), so the module recomputes only after a new item_meta record
// or a new applied transaction, and never rewrites the values an item already has.

import type { Affine2D, ItemMeta, ItemMetaBatch, ItemQuery, RenderStreamExtension } from "@godot-scene-web/render-stream-client";

import { boxFullyOutsideDesign, computeAnchoredScaleStamp, type ScalePivot } from "@/mirror/hoverTipScaleMath";
import {
  CARD_REWARD_CARD_RESOLVED,
  CARD_REWARD_GROUP_RESOLVED,
  resolveViewScale,
  TREASURE_RELIC_RESOLVED,
  viewScaleActive,
  type ViewScaleResolved
} from "@/mirror/viewScale";
import {
  RS_GROUP_CARD_REWARD_CARD,
  RS_GROUP_CARD_REWARD_ROOT,
  RS_GROUP_TREASURE_RELIC,
  VIEW_SCALE_GROUPS
} from "@/stream-ext/groups";

const DESIGN_HEIGHT = 1080;

export interface ViewScaleOptions {
  /** The seat's presentation width (the design space the clamp works in; 1920, or wider at a viewer's aspect). */
  readonly designWidth: number;
}

interface Desired {
  scale: number;
  isGroup: boolean;
  pivot: ScalePivot;
  translateX: number;
  translateY: number;
  noClamp: boolean;
}

/** The resolution of one item's scale entry: the old table first, then the leaf-detected group entries. */
export function resolveStreamViewScale(m: ItemMeta): Desired | null {
  if (m.groups.includes(RS_GROUP_CARD_REWARD_ROOT)) return { ...CARD_REWARD_GROUP_RESOLVED };
  if (m.groups.includes(RS_GROUP_CARD_REWARD_CARD)) return { ...CARD_REWARD_CARD_RESOLVED };
  if (m.groups.includes(RS_GROUP_TREASURE_RELIC)) return { ...TREASURE_RELIC_RESOLVED };
  const resolved: ViewScaleResolved = resolveViewScale(m.scene ?? null, m.path ?? null);
  return viewScaleActive(resolved)
    ? {
        scale: resolved.scale,
        isGroup: resolved.isGroup,
        pivot: resolved.pivot,
        translateX: resolved.translateX,
        translateY: resolved.translateY,
        noClamp: resolved.noClamp
      }
    : null;
}

/** The six-value affine that scales by `s` about (pivotX, pivotY) then translates by (offsetX, offsetY). */
export function scaleStampAffine(
  s: number,
  pivotX: number,
  pivotY: number,
  offsetX: number,
  offsetY: number
): Affine2D {
  return [s, 0, 0, s, offsetX + pivotX * (1 - s), offsetY + pivotY * (1 - s)];
}

export function createViewScaleExtension(options: ViewScaleOptions): RenderStreamExtension {
  const desired = new Map<number, Desired>();
  let dirty = true;
  let lastSeq: number | null = null;

  return {
    id: "couchcoop.viewScale",
    wants: { fields: ["scene", "path"], groups: [...VIEW_SCALE_GROUPS] },
    onItemMeta: (b) => {
      if (b.form === "full") desired.clear();
      for (const m of b.items) {
        const d = resolveStreamViewScale(m);
        if (d === null) desired.delete(m.id);
        else desired.set(m.id, d);
      }
      dirty = true;
    },
    onItemsRemoved: (ids) => {
      for (const id of ids) desired.delete(id);
      dirty = true;
    },
    beforeDraw: (f) => {
      if (!dirty && f.seq === lastSeq) return;
      lastSeq = f.seq;
      dirty = false;

      for (const [id, d] of desired) {
        const box = d.isGroup ? f.query.subtreeRect(id) : f.query.rect(id);
        if (box === null || boxFullyOutsideDesign(box, options.designWidth, DESIGN_HEIGHT)) {
          f.overrides.clear(id);
          continue;
        }
        const stamp = computeAnchoredScaleStamp(
          box, d.scale, options.designWidth, DESIGN_HEIGHT, d.pivot, d.translateX, d.translateY, d.noClamp);
        if (stamp === null) {
          f.overrides.clear(id);
          continue;
        }
        f.overrides.set(id, {
          transform: scaleStampAffine(d.scale, stamp.pivotX, stamp.pivotY, stamp.offsetX, stamp.offsetY)
        });
      }
    },
    dispose: () => {
      desired.clear();
      dirty = false;
    }
  };
}
