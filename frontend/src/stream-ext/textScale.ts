// Rigid label enlargement from the mirror's readability table. Label leaves compose under
// view-scale widgets and hover-tip roots, which own different item ids.

import type { Affine2D, ItemMeta, ItemQuery, OverrideTable, Rect, RenderStreamExtension } from "@godot-scene-web/render-stream-client";

import {
  resolveTextScaleClasses,
  resolveTextScaleDecls,
  ruleSpecificity,
  STREAM_TEXT_FACTOR_OVERRIDES,
  streamTextScaleOf,
  TEXT_SCALE_CLASS_PREFIX,
  TEXT_SCALE_RULES
} from "@/mirror/textScaleClasses";
import { RS_GROUP_HOVER_TIP, VIEW_SCALE_GROUPS } from "@/stream-ext/groups";
import { resolveStreamViewScale } from "@/stream-ext/viewScale";

export type TextPivot = "left" | "center" | "right";

// Item metadata has no label alignment. These edge anchors come from recorded mirror label
// alignment; unlisted labels use the centre. Rigid card-description/type transforms already
// use the centre in the old table, regardless of the text's alignment.
export const STREAM_TEXT_PIVOT: Readonly<Record<string, TextPivot>> = {
  "hovertip-description": "left",
  "topbar-hp": "left",
  "topbar-gold": "left",
  "topbar-floor": "left",
  "topbar-timer": "left",
  "topbar-deck-count": "right",
  "star-counter": "left",
  "intent-value": "left",
  "relic-amount": "right"
};

export interface StreamTextScale {
  readonly key: string;
  readonly factor: number;
  readonly pivot: TextPivot;
}

export interface ScaledTextLabel extends StreamTextScale {
  readonly id: number;
}

type TextScaleSeam = { __renderStreamTextScale?: () => readonly ScaledTextLabel[] };
const rulesByClass = new Map(TEXT_SCALE_RULES.map((r) => [TEXT_SCALE_CLASS_PREFIX + r.key, r]));

export function resolveStreamTextScale(item: ItemMeta): StreamTextScale | null {
  // Never compete for a widget/root id owned by view-scale or hover-tips, even if a malformed
  // identity matches a label. Their ancestors' overrides will compose with ours normally.
  if (!item.node || item.groups.includes(RS_GROUP_HOVER_TIP) ||
      VIEW_SCALE_GROUPS.some((g) => item.groups.includes(g)) || resolveStreamViewScale(item) !== null) return null;
  const path = item.path === "." ? "" : (item.path ?? null);
  const scene = item.scene ?? null;
  const classes = resolveTextScaleClasses(scene, path);
  if (classes.length === 0) return null;
  // Match the old declaration cascade, including the multiplayer health-bar override.
  const matched = classes.map((c) => rulesByClass.get(c)!).sort((a, b) => ruleSpecificity(a) - ruleSpecificity(b));
  const key = matched[matched.length - 1].key;
  const factor = STREAM_TEXT_FACTOR_OVERRIDES[key] ?? streamTextScaleOf(resolveTextScaleDecls(scene, path));
  return { key, factor, pivot: STREAM_TEXT_PIVOT[key] ?? "center" };
}

/** Edge anchors only apply to unrotated, unskewed labels; a rotated AABB loses that edge. */
export function streamTextPivot(box: Rect, pivot: TextPivot, transform: Affine2D | null): { x: number; y: number } {
  const unrotated = transform !== null && transform[0] > 0 && transform[3] > 0 &&
    Math.abs(transform[1]) < 1e-6 && Math.abs(transform[2]) < 1e-6;
  const x = !unrotated || pivot === "center" ? box.x + box.w / 2 : pivot === "left" ? box.x : box.x + box.w;
  return { x, y: box.y + box.h / 2 };
}

function rewardTextArea(key: string, labelId: number, parent: number | null, query: ItemQuery): Rect | null {
  if (parent === null || (key !== "rewards-screen-label" && key !== "reward-button-label")) return null;
  const xf = query.transform(parent);
  if (!xf || xf[0] <= 0 || xf[3] <= 0 || Math.abs(xf[1]) > 1e-6 || Math.abs(xf[2]) > 1e-6) return null;
  // Centre inside the Label's laid-out box, independent of ink width and overhanging row art.
  // A zero-sized box measures nothing, so it takes the painted-bounds fallback below.
  const control = query.controlRect(labelId);
  let area = control && control.w > 0 && control.h > 0 ? control : query.rect(parent);
  if (!area) {
    // An undrawn container has no command rect. Its origin and the row's painted bounds
    // still delimit the space to the right of the icon, without using a measured ink width.
    const row = query.parent(parent);
    const rowBox = row === null ? null : query.rect(row) ?? query.subtreeRect(row);
    if (rowBox) {
      const x = Math.max(rowBox.x, xf[4]);
      area = { ...rowBox, x, w: rowBox.x + rowBox.w - x };
    }
  }
  if (!area || area.w <= 0 || area.h <= 0) return null;
  // Read the old rule's right padding so its centring and the stream's cannot drift.
  const padding = rulesByClass.get(TEXT_SCALE_CLASS_PREFIX + key)!.self!["padding-right"];
  return { ...area, w: area.w * (1 - Number.parseFloat(padding) / 100) };
}

export function createTextScaleExtension(): RenderStreamExtension {
  const desired = new Map<number, StreamTextScale>();
  const applied = new Map<number, ScaledTextLabel>();
  let overrides: OverrideTable | null = null;
  const debug = (): readonly ScaledTextLabel[] => [...applied.values()]
    .filter((label) => overrides?.get(label.id) != null);

  return {
    id: "couchcoop.textScale",
    wants: { fields: ["scene", "path"], groups: [...VIEW_SCALE_GROUPS, RS_GROUP_HOVER_TIP] },
    onSession() {
      desired.clear();
      applied.clear();
      overrides = null;
      if (typeof window !== "undefined") (window as unknown as TextScaleSeam).__renderStreamTextScale = debug;
    },
    onItemMeta(batch) {
      if (batch.form === "full") desired.clear();
      for (const item of batch.items) {
        const scale = resolveStreamTextScale(item);
        if (scale === null || scale.factor === 1) desired.delete(item.id);
        else desired.set(item.id, scale);
      }
    },
    onItemsRemoved(ids) {
      for (const id of ids) desired.delete(id);
    },
    beforeDraw(frame) {
      overrides = frame.overrides;

      for (const id of applied.keys()) {
        if (!desired.has(id)) { frame.overrides.clear(id); applied.delete(id); }
      }
      for (const [id, scale] of desired) {
        const box = frame.query.rect(id);
        if (!frame.query.visible(id) || !box || box.w <= 0 || box.h <= 0) {
          if (applied.delete(id)) frame.overrides.clear(id);
          continue;
        }
        const pivot = streamTextPivot(box, scale.pivot, frame.query.transform(id));
        // Ancestor overrides act first, including input-driven movement on redraws without
        // a transaction. Keep the anchor fixed where those overrides now display it.
        const parent = frame.query.parent(id);
        const area = rewardTextArea(scale.key, id, parent, frame.query);
        // Cap reward enlargement uniformly; labels wider than the area at game size
        // overflow to the right so their left edge stays clear of the icon.
        const s = area ? Math.min(scale.factor, Math.max(1, area.w / box.w)) : scale.factor;
        const offset = { x: area ? area.x + Math.max(area.w, s * box.w) / 2 - pivot.x : 0, y: 0 };
        if (parent !== null) {
          const xf = frame.overrides.effective(parent);
          const { x, y } = pivot;
          pivot.x = xf[0] * x + xf[2] * y + xf[4];
          pivot.y = xf[1] * x + xf[3] * y + xf[5];
          // Translation is a vector: map it without the ancestor's origin.
          offset.y = xf[1] * offset.x;
          offset.x *= xf[0];
        }
        const transform: Affine2D = [s, 0, 0, s, pivot.x - s * pivot.x + offset.x, pivot.y - s * pivot.y + offset.y];
        const current = frame.overrides.get(id)?.transform;
        if (!current || transform.some((value, index) => value !== current[index])) {
          if (area) frame.overrides.set(id, { transform });
          else frame.overrides.scaleAbout(id, s, s, pivot.x, pivot.y);
        }
        applied.set(id, { id, ...scale });
      }
    },
    dispose() {
      desired.clear();
      applied.clear();
      overrides = null;
      if (typeof window !== "undefined" && (window as unknown as TextScaleSeam).__renderStreamTextScale === debug) {
        delete (window as unknown as TextScaleSeam).__renderStreamTextScale;
      }
    }
  };
}
